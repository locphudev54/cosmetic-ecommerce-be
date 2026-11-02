import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { CursorPaginatedResponseDto, OffsetPaginatedResponseDto } from 'core'
import { PrismaService } from 'database/prisma/prisma.service'
import { EmailProducer } from 'domains/email/email.producer'
import { UsersService } from 'domains/users/users.service'
import { OrderSortBy, OrderStatus, PaginationType, SortOrder, UserRole } from 'enums'
import { OrderCursorData } from 'types'
import { UtcDateRange } from 'utils'
import { CreateOrderDto } from './dto/create-order.dto'
import { QueryOrderDto } from './dto/query-order.dto'
import {
  ORDER_INCLUDE,
  ORDER_STATUS_TRANSITIONS,
  OrderWithDetails,
  isValidStatusTransition
} from './entities/order.entity'
import { OrderRedisService } from './order-redis.service'
import { RedisLockService } from 'core/redis-lock/redis-lock.service'

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderRedis: OrderRedisService,
    private readonly redisLockService: RedisLockService,
    private readonly emailProducer: EmailProducer,
    private readonly usersService: UsersService
  ) {}

  // ==========================================
  // Create Order (Authenticated User)
  // ==========================================

  async createOrder(
    userId: string,
    dto: CreateOrderDto,
    idempotencyKey?: string
  ): Promise<OrderWithDetails> {
    // 1. Check idempotency: Redis first
    if (idempotencyKey) {
      const cachedOrder = await this.orderRedis.getIdempotencyResponse<OrderWithDetails>(
        idempotencyKey
      )
      if (cachedOrder) {
        this.logger.log(`Order idempotency hit (Redis): ${idempotencyKey}`)
        return cachedOrder
      }

      // Fallback: check DB
      const existingOrder = await this.prisma.order.findUnique({
        where: { idempotencyKey },
        include: ORDER_INCLUDE
      })
      if (existingOrder) {
        this.logger.log(`Order idempotency hit (DB): ${idempotencyKey}`)
        return existingOrder
      }
    }

    // 2. Validate cart exists and belongs to user
    const cart = await this.prisma.cart.findUnique({
      where: { id: dto.cartId },
      include: {
        items: {
          include: {
            productVariant: true
          }
        }
      }
    })

    if (!cart) {
      throw new NotFoundException('Cart not found')
    }

    if (cart.userId && cart.userId !== userId) {
      throw new BadRequestException('Cart does not belong to this user')
    }

    // 3. Filter to selected items only
    const selectedItems = cart.items.filter((item) => dto.selectedCartItemIds.includes(item.id))
    if (selectedItems.length === 0) {
      throw new BadRequestException('No valid items selected for checkout')
    }

    // 4. Acquire distributed locks for all variants
    const lockKeys: { key: string; lockValue: string }[] = []
    try {
      for (const item of selectedItems) {
        const lockValue = await this.redisLockService.acquire(
          `order:variant:${item.productVariantId}`,
          {
            ttl: 15000, // 15 seconds TTL for locks
            timeout: 30000, // Wait up to 30 seconds to acquire each lock
            retryDelay: 100 // 100ms between retries
          }
        )

        // if (!lockValue) {
        //   throw new ConflictException(
        //     `Could not acquire lock for variant ${item.productVariantId}. Please try again.`
        //   )
        // }
        lockKeys.push({ key: item.productVariantId, lockValue })
      }

      // 5. Validate stock inside lock
      for (const item of selectedItems) {
        const variant = await this.prisma.productVariant.findUnique({
          where: { id: item.productVariantId },
          select: { stockOnHand: true, isActive: true, name: true }
        })

        if (!variant || !variant.isActive) {
          throw new BadRequestException(`Variant ${item.productVariantId} is no longer available`)
        }

        if (variant.stockOnHand !== null && variant.stockOnHand < item.quantity) {
          throw new BadRequestException(
            `Insufficient stock for "${variant.name}". Available: ${variant.stockOnHand}, Requested: ${item.quantity}`
          )
        }
      }

      // 6. Calculate total
      const totalPrice = selectedItems.reduce(
        (sum, item) => sum + Number(item.productVariant.sellingPrice) * item.quantity,
        0
      )
      const shippingFee = dto.shippingFee ?? 0

      // 7. Generate unique order code
      const orderCode = this.generateOrderCode()

      // 8. Create order, order details, shipping info, decrement stock — all in a single transaction
      const order = await this.prisma.$transaction(async (tx) => {
        // Decrement stock
        for (const item of selectedItems) {
          await tx.productVariant.update({
            where: { id: item.productVariantId },
            data: {
              stockOnHand: { decrement: item.quantity }
            }
          })
        }

        // Create order
        const newOrder = await tx.order.create({
          data: {
            userId,
            idempotencyKey: idempotencyKey || null,
            code: orderCode,
            status: OrderStatus.PROCESSING,
            totalPrice: totalPrice + shippingFee,
            shippingFee,
            paymentMethod: dto.paymentMethod,
            items: {
              create: selectedItems.map((item) => ({
                productVariantId: item.productVariantId,
                quantity: item.quantity,
                productPrice: item.productVariant.sellingPrice
              }))
            },
            shippingInfo: {
              create: {
                fullName: dto.shippingInfo.fullName,
                email: dto.shippingInfo.email,
                phoneNumber: dto.shippingInfo.phoneNumber,
                province: dto.shippingInfo.province,
                district: dto.shippingInfo.district,
                ward: dto.shippingInfo.ward,
                streetAddress: dto.shippingInfo.streetAddress || '',
                note: dto.shippingInfo.note || ''
              }
            }
          },
          include: ORDER_INCLUDE
        })

        // Remove purchased items from cart
        await tx.cartItem.deleteMany({
          where: {
            id: { in: dto.selectedCartItemIds },
            cartId: dto.cartId
          }
        })

        // Recalculate cart total
        const remainingItems = await tx.cartItem.findMany({
          where: { cartId: dto.cartId },
          select: { subtotal: true }
        })
        const newCartTotal = remainingItems.reduce((sum, item) => sum + Number(item.subtotal), 0)
        await tx.cart.update({
          where: { id: dto.cartId },
          data: { totalPrice: newCartTotal, version: { increment: 1 } }
        })

        return newOrder
      })

      // 9. Cache idempotency response
      if (idempotencyKey) {
        await this.orderRedis.setIdempotencyResponse(idempotencyKey, order)
      }

      // 10. Send order confirmation email (non-blocking)
      // try {
      //   await this.emailProducer.sendOrderConfirmationEmail(
      //     dto.shippingInfo.email,
      //     dto.shippingInfo.fullName,
      //     orderCode,
      //     totalPrice + shippingFee
      //   )
      // } catch (error) {
      //   this.logger.error(`Failed to enqueue order confirmation email for ${orderCode}`, error)
      // }

      return order
    } finally {
      // 11. Release all locks
      for (const lock of lockKeys) {
        await this.redisLockService.release(`order:variant:${lock.key}`, lock.lockValue)
        // await this.orderRedis.releaseLock(lock.key, lock.lockValue)
      }
    }
  }

  // ==========================================
  // Create Guest Order
  // ==========================================

  async createGuestOrder(dto: CreateOrderDto, idempotencyKey?: string): Promise<OrderWithDetails> {
    // Find or create guest user
    const user = await this.usersService.findOrCreateGuestUser(
      dto.shippingInfo.email,
      dto.shippingInfo.fullName,
      dto.shippingInfo.phoneNumber
    )

    return this.createOrder(user.id, dto, idempotencyKey)
  }

  // ==========================================
  // Find One
  // ==========================================

  async findOne(id: string): Promise<OrderWithDetails> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: ORDER_INCLUDE
    })

    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`)
    }

    return order
  }

  // ==========================================
  // Find All (offset + cursor pagination)
  // ==========================================

  async findAll(query: QueryOrderDto, utcDateRange?: UtcDateRange) {
    const paginationType = query.paginationType || PaginationType.OFFSET

    if (paginationType === PaginationType.CURSOR) {
      return this.findAllWithCursorPagination(query, utcDateRange)
    }

    return this.findAllWithOffsetPagination(query, utcDateRange)
  }

  private async findAllWithOffsetPagination(query: QueryOrderDto, utcDateRange?: UtcDateRange) {
    const page = query.page || 1
    const limit = query.limit || 25
    const skip = (page - 1) * limit

    const where = this.buildWhereClause(query, utcDateRange)
    const orderBy = this.buildOrderByClause(query.sortBy, query.sortOrder)

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy,
        skip,
        take: limit
      }),
      this.prisma.order.count({ where })
    ])

    return new OffsetPaginatedResponseDto({
      items: orders,
      limit,
      page,
      total
    })
  }

  private async findAllWithCursorPagination(query: QueryOrderDto, utcDateRange?: UtcDateRange) {
    const limit = query.limit || 20
    const cursor = query.cursor
    const sortBy = query.sortBy || OrderSortBy.CREATED_AT
    const sortOrder = query.sortOrder || SortOrder.DESC

    let cursorData: OrderCursorData | null = null
    if (cursor) {
      try {
        cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'))
      } catch {
        throw new BadRequestException('Invalid cursor format')
      }
    }

    const baseWhere = this.buildWhereClause(query, utcDateRange)
    const where = this.buildCursorWhereClause(baseWhere, cursorData, sortBy, sortOrder)
    const orderBy = this.buildOrderByClause(sortBy, sortOrder)

    let [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy,
        take: limit + 1
      }),
      this.prisma.order.count({ where })
    ])

    const hasNextPage = orders.length > limit
    if (hasNextPage) {
      orders.pop()
    }

    let nextCursor: string | null = null
    if (hasNextPage && orders.length > 0) {
      const lastItem = orders[orders.length - 1]
      nextCursor = this.encodeCursor(lastItem, sortBy)
    }

    let previousCursor: string | null = null
    if (orders.length > 0 && cursor) {
      const firstItem = orders[0]
      previousCursor = this.encodeCursor(firstItem, sortBy)
    }

    return new CursorPaginatedResponseDto({
      items: orders,
      nextCursor,
      previousCursor,
      total,
      hasNextPage,
      hasPreviousPage: !!cursor
    })
  }

  private buildWhereClause(query: QueryOrderDto, utcDateRange?: UtcDateRange) {
    const where: Prisma.OrderWhereInput = { AND: [] }

    if (query.status && query.status.length > 0) {
      ;(where.AND as Prisma.OrderWhereInput[]).push({
        status: { in: query.status }
      })
    }

    if (query.userId) {
      ;(where.AND as Prisma.OrderWhereInput[]).push({ userId: query.userId })
    }

    if (query.search) {
      ;(where.AND as Prisma.OrderWhereInput[]).push({
        code: { contains: query.search, mode: 'insensitive' }
      })
    }

    if (utcDateRange) {
      ;(where.AND as Prisma.OrderWhereInput[]).push({
        createdAt: {
          gte: utcDateRange.from,
          lte: utcDateRange.to
        }
      })
    }

    if ((where.AND as Prisma.OrderWhereInput[]).length === 0) {
      delete where.AND
    }

    return where
  }

  private buildOrderByClause(sortBy?: OrderSortBy, sortOrder?: SortOrder) {
    const resolvedSortBy = sortBy || OrderSortBy.CREATED_AT
    const resolvedSortOrder = sortOrder || SortOrder.DESC
    const orderBy: Prisma.OrderOrderByWithRelationInput[] = []

    switch (resolvedSortBy) {
      case OrderSortBy.CREATED_AT:
        orderBy.push({ createdAt: resolvedSortOrder })
        break
      case OrderSortBy.TOTAL_PRICE:
        orderBy.push({ totalPrice: resolvedSortOrder })
        break
      case OrderSortBy.STATUS:
        orderBy.push({ status: resolvedSortOrder })
        break
      case OrderSortBy.CODE:
        orderBy.push({ code: resolvedSortOrder })
        break
    }

    orderBy.push({ id: resolvedSortOrder })

    return orderBy
  }

  private buildCursorWhereClause(
    baseWhere: Prisma.OrderWhereInput,
    cursorData: OrderCursorData | null,
    sortBy: OrderSortBy,
    sortOrder: SortOrder
  ): Prisma.OrderWhereInput {
    if (!cursorData) {
      return baseWhere
    }

    const where: Prisma.OrderWhereInput = { ...baseWhere }
    const cursorConditions: Prisma.OrderWhereInput[] = []
    const operator = sortOrder === SortOrder.ASC ? 'gt' : 'lt'

    switch (sortBy) {
      case OrderSortBy.CREATED_AT:
        if (cursorData.createdAt) {
          const createdAt = new Date(cursorData.createdAt)
          cursorConditions.push({
            OR: [
              { createdAt: { [operator]: createdAt } },
              {
                AND: [{ createdAt: { equals: createdAt } }, { id: { [operator]: cursorData.id } }]
              }
            ]
          })
        }
        break
      case OrderSortBy.TOTAL_PRICE:
        if (cursorData.totalPrice !== undefined) {
          const totalPrice = new Prisma.Decimal(cursorData.totalPrice)
          cursorConditions.push({
            OR: [
              { totalPrice: { [operator]: totalPrice } },
              {
                AND: [{ totalPrice: { equals: totalPrice } }, { id: { [operator]: cursorData.id } }]
              }
            ]
          })
        }
        break
      case OrderSortBy.STATUS:
        if (cursorData.status) {
          cursorConditions.push({
            OR: [
              { status: { [operator]: cursorData.status } },
              {
                AND: [
                  { status: { equals: cursorData.status } },
                  { id: { [operator]: cursorData.id } }
                ]
              }
            ]
          })
        }
        break
      case OrderSortBy.CODE:
        if (cursorData.code) {
          cursorConditions.push({
            OR: [
              { code: { [operator]: cursorData.code } },
              {
                AND: [{ code: { equals: cursorData.code } }, { id: { [operator]: cursorData.id } }]
              }
            ]
          })
        }
        break
    }
    return where

    if (cursorConditions.length > 0) {
      if (where.AND) {
        where.AND = [...(where.AND as Prisma.OrderWhereInput[]), ...cursorConditions]
      } else {
        where.AND = cursorConditions
      }
    }
  }

  private encodeCursor(order: OrderWithDetails, sortBy: OrderSortBy) {
    const cursorData: OrderCursorData = { id: order.id }

    switch (sortBy) {
      case OrderSortBy.CREATED_AT:
        cursorData.createdAt = order.createdAt
        break
      case OrderSortBy.TOTAL_PRICE:
        cursorData.totalPrice = new Prisma.Decimal(order.totalPrice).toString()
        break
      case OrderSortBy.STATUS:
        cursorData.status = order.status as OrderStatus
        break
      case OrderSortBy.CODE:
        cursorData.code = order.code || undefined
        break
    }

    return Buffer.from(JSON.stringify(cursorData)).toString('base64')
  }

  // ==========================================
  // Cancel Order
  // ==========================================

  async cancelOrder(orderId: string, userId: string, reason?: string, isAdmin: boolean = false) {
    const order = await this.findOne(orderId)

    // Check ownership (unless admin)
    if (!isAdmin && order.userId !== userId) {
      throw new BadRequestException('You can only cancel your own orders')
    }

    // Validate FSM transition
    if (!isValidStatusTransition(order.status as OrderStatus, OrderStatus.CANCELLED)) {
      throw new BadRequestException(
        `Cannot cancel order in status "${
          order.status
        }". Allowed transitions: ${this.getAllowedTransitionsText(order.status as OrderStatus)}`
      )
    }

    // Restore stock and update order in transaction
    return this.prisma.$transaction(async (tx) => {
      // Restore stock for each order item
      for (const item of order.items) {
        await tx.productVariant.update({
          where: { id: item.productVariantId },
          data: {
            stockOnHand: { increment: item.quantity }
          }
        })
      }

      // Update order
      return tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.CANCELLED,
          cancelReason: reason || '',
          cancelledAt: new Date()
        },
        include: ORDER_INCLUDE
      })
    })
  }

  // ==========================================
  // Update Order Status (Admin)
  // ==========================================

  async updateOrderStatus(orderId: string, newStatus: OrderStatus) {
    const order = await this.findOne(orderId)
    const currentStatus = order.status as OrderStatus

    // Validate FSM transition
    if (!isValidStatusTransition(currentStatus, newStatus)) {
      throw new BadRequestException(
        `Cannot transition from "${currentStatus}" to "${newStatus}". Allowed transitions: ${this.getAllowedTransitionsText(
          currentStatus
        )}`
      )
    }

    // Build update data with relevant timestamps
    const updateData: Prisma.OrderUpdateInput = {
      status: newStatus
    }

    switch (newStatus) {
      case OrderStatus.PAID:
        updateData.paidAt = new Date()
        break
      case OrderStatus.DELIVERED:
        updateData.deliveredAt = new Date()
        break
      case OrderStatus.CANCELLED:
        updateData.cancelledAt = new Date()
        break
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: ORDER_INCLUDE
    })
  }

  // ==========================================
  // Shipping Fee
  // ==========================================

  getShippingFee(): number {
    // Hardcoded for now — will be replaced with third-party API
    return 26000
  }

  // ==========================================
  // Helpers
  // ==========================================

  private generateOrderCode(): string {
    const timestamp = Date.now().toString(36).toUpperCase()
    const random = Math.random().toString(36).substring(2, 6).toUpperCase()
    return `ORD-${timestamp}-${random}`
  }

  private getAllowedTransitionsText(status: OrderStatus): string {
    const allowed = ORDER_STATUS_TRANSITIONS[status] || []
    return allowed.length > 0 ? allowed.join(', ') : '(none — terminal state)'
  }
}
