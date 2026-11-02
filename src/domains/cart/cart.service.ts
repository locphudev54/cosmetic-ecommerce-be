import {
  Injectable,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { CartItem } from '@prisma/client'
import { CartGateway } from './cart.gateway'
import { AddToCartDto } from './dto/add-to-cart.dto'
import { UpdateCartItemDto } from './dto/update-cart-item.dto'
import { BulkRemoveCartItemsDto } from './dto/bulk-remove-cart-items.dto'
import { CART_INCLUDE, CartWithItems, EnrichedCart, EnrichedCartItem } from './entities/cart.entity'
import ms from 'ms'
import { Request, Response } from 'express'
import { PrismaService } from 'database/prisma/prisma.service'

const CART_COOKIE_NAME = 'cart_id'

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartGateway: CartGateway,
    private readonly configService: ConfigService
  ) {}

  async getCart(req: Request, res: Response, userId?: string) {
    const guestCartId = this.getGuestCartId(req)
    const cart = await this.getOrCreateCart(userId, guestCartId)

    if (!userId && cart?.id) {
      this.setGuestCartCookie(res, cart.id)
    }

    return cart
  }

  // ==========================================
  // Request-Oriented Facades (for controller)
  // ==========================================

  async addToCart(
    req: Request,
    res: Response,
    userId: string | undefined,
    dto: AddToCartDto,
    idempotencyKey?: string
  ): Promise<EnrichedCart> {
    const guestCartId = this.getGuestCartId(req)
    const cart = await this.getOrCreateCart(userId, guestCartId)

    if (!userId && cart?.id) {
      this.setGuestCartCookie(res, cart.id)
    }

    const updatedCart = await this.addItem(cart.id, dto, idempotencyKey)
    this.notifyCartUpdated(userId, updatedCart)

    return updatedCart
  }

  async updateCartItem(
    req: Request,
    userId: string | undefined,
    itemId: string,
    dto: UpdateCartItemDto
  ): Promise<EnrichedCart> {
    const guestCartId = this.getGuestCartId(req)
    const cart = await this.getOrCreateCart(userId, guestCartId)
    const updatedCart = await this.updateItem(itemId, cart.id, dto)
    this.notifyCartUpdated(userId, updatedCart)

    return updatedCart
  }

  async removeCartItem(
    req: Request,
    userId: string | undefined,
    itemId: string,
    version: number
  ): Promise<EnrichedCart> {
    const guestCartId = this.getGuestCartId(req)
    const cart = await this.getOrCreateCart(userId, guestCartId)
    const updatedCart = await this.removeItem(itemId, cart.id, version)
    this.notifyCartUpdated(userId, updatedCart)

    return updatedCart
  }

  async bulkRemoveCartItems(
    req: Request,
    userId: string | undefined,
    dto: BulkRemoveCartItemsDto
  ): Promise<EnrichedCart> {
    const guestCartId = this.getGuestCartId(req)
    const cart = await this.getOrCreateCart(userId, guestCartId)
    const updatedCart = await this.bulkRemoveItems(cart.id, dto)
    this.notifyCartUpdated(userId, updatedCart)

    return updatedCart
  }

  async mergeCart(req: Request, res: Response, userId: string): Promise<EnrichedCart> {
    const guestCartId = this.getGuestCartId(req)

    if (!guestCartId) {
      return this.getOrCreateCart(userId)
    }

    const mergedCart = await this.mergeGuestCart(guestCartId, userId)
    this.clearGuestCartCookie(res)
    this.notifyCartUpdated(userId, mergedCart)

    return mergedCart
  }

  private getGuestCartId(req: Request): string | undefined {
    return req.cookies?.[CART_COOKIE_NAME]
  }

  private setGuestCartCookie(res: Response, cartId: string): void {
    res.cookie(CART_COOKIE_NAME, cartId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: +ms(this.configService.get('CART_COOKIE_MAX_AGE'))
    })
  }

  private clearGuestCartCookie(res: Response): void {
    res.clearCookie(CART_COOKIE_NAME)
  }

  // ==========================================
  // Get or Create Cart
  // ==========================================

  /**
   * Get or create a cart for the current user/guest.
   * Read-through cache: Redis first → DB fallback → create if not found.
   */
  async getOrCreateCart(userId?: string, guestCartId?: string): Promise<EnrichedCart> {
    // 1. Try to find existing cart
    const cart = await this.findCart(userId, guestCartId)
    if (cart) {
      return this.enrichCartWithPriceChanges(cart)
    }

    // 2. Create new cart
    const newCart = await this.createCart(userId)
    return this.enrichCartWithPriceChanges(newCart)
  }

  /**
   * Find cart by userId or guestCartId.
   * Uses read-through cache: Redis → DB.
   */
  private async findCart(userId?: string, guestCartId?: string): Promise<CartWithItems | null> {
    const cartId = userId ? await this.getCartIdByUserId(userId) : guestCartId

    if (!cartId) return null

    // Try Redis cache first
    // const cachedCart = await this.cartRedis.getCart(cartId)
    // if (cachedCart) {
    //   return cachedCart
    // }

    // Fallback to DB
    const dbCart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: CART_INCLUDE
    })

    // if (dbCart) {
    //   // Cache in Redis
    //   const isGuest = !dbCart.userId
    //   await this.cartRedis.setCart(dbCart.id, dbCart, isGuest)
    // }

    return dbCart
  }

  /**
   * Get cart ID by user ID from DB
   */
  private async getCartIdByUserId(userId: string): Promise<string | null> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      select: { id: true }
    })
    return cart?.id || null
  }

  /**
   * Create a new cart (for guest or authenticated user)
   */
  private async createCart(userId?: string): Promise<CartWithItems> {
    // const guestTtlMs = this.cartRedis.getGuestCartTtlMs()
    // const expiresAt = userId ? null : new Date(Date.now() + guestTtlMs)

    const cart = await this.prisma.cart.create({
      data: {
        userId: userId || null,
        totalPrice: 0
        // expiresAt
      },
      include: CART_INCLUDE
    })

    // Cache in Redis
    const isGuest = !userId
    // await this.cartRedis.setCart(cart.id, cart, isGuest)

    return cart
  }

  // ==========================================
  // Add Item to Cart
  // ==========================================

  /**
   * Add item to cart with idempotency key check.
   * If the variant already exists in this cart, increment quantity.
   */
  async addItem(cartId: string, dto: AddToCartDto, idempotencyKey?: string): Promise<EnrichedCart> {
    // 1. Check idempotency key (return cached response for retries)
    // if (idempotencyKey) {
    //   const cachedResponse = await this.cartRedis.getIdempotencyResponse(idempotencyKey)
    //   if (cachedResponse) {
    //     this.logger.log(`Idempotency hit: ${idempotencyKey}`)
    //     return cachedResponse
    //   }
    // }

    // 2. Validate product variant exists and is available
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: dto.productVariantId },
      select: { id: true, sellingPrice: true, stockOnHand: true, isActive: true }
    })

    if (!variant) {
      throw new NotFoundException('Product variant not found')
    }

    if (!variant.isActive) {
      throw new BadRequestException('This product variant is no longer available')
    }

    if (variant.stockOnHand !== null && variant.stockOnHand < dto.quantity) {
      throw new BadRequestException(`Insufficient stock. Available: ${variant.stockOnHand}`)
    }

    // 3. Check if variant already in cart (upsert)
    const existingItem = await this.prisma.cartItem.findUnique({
      where: {
        cartId_productVariantId: {
          cartId,
          productVariantId: dto.productVariantId
        }
      }
    })

    if (existingItem) {
      // Increment quantity
      const newQuantity = existingItem.quantity + dto.quantity
      const cappedQuantity =
        variant.stockOnHand !== null ? Math.min(newQuantity, variant.stockOnHand) : newQuantity

      await this.prisma.cartItem.update({
        where: { id: existingItem.id },
        data: {
          quantity: cappedQuantity,
          price: variant.sellingPrice,
          subtotal: +variant.sellingPrice * cappedQuantity
        }
      })
    } else {
      // Create new cart item
      await this.prisma.cartItem.create({
        data: {
          cartId,
          productVariantId: dto.productVariantId,
          quantity: dto.quantity,
          price: variant.sellingPrice,
          subtotal: +variant.sellingPrice * dto.quantity
        }
      })
    }

    // 4. Recalculate cart totals and bump version
    const updatedCart = await this.recalculateAndSync(cartId)

    // 5. Store idempotency response
    // if (idempotencyKey) {
    //   await this.cartRedis.setIdempotencyResponse(idempotencyKey, updatedCart)
    // }

    return updatedCart
  }

  // ==========================================
  // Update Cart Item
  // ==========================================

  /**
   * Update a cart item (quantity change or variant swap) with optimistic locking.
   */
  async updateItem(itemId: string, cartId: string, dto: UpdateCartItemDto): Promise<EnrichedCart> {
    // 1. Optimistic lock check
    await this.checkOptimisticLock(cartId, dto.version)

    // 2. Find existing item
    const existingItem = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cartId }
    })

    if (!existingItem) {
      throw new NotFoundException('Cart item not found')
    }

    // 3. Handle variant swap
    if (dto.newProductVariantId && dto.newProductVariantId !== existingItem.productVariantId) {
      return this.swapVariant(existingItem, cartId, dto)
    }

    // 4. Handle quantity update
    if (dto.quantity !== undefined) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: existingItem.productVariantId },
        select: { sellingPrice: true, stockOnHand: true }
      })

      if (!variant) {
        throw new NotFoundException('Product variant not found')
      }

      if (variant.stockOnHand !== null && dto.quantity > variant.stockOnHand) {
        throw new BadRequestException(`Insufficient stock. Available: ${variant.stockOnHand}`)
      }

      await this.prisma.cartItem.update({
        where: { id: itemId },
        data: {
          quantity: dto.quantity,
          price: variant.sellingPrice,
          subtotal: +variant.sellingPrice * dto.quantity
        }
      })
    }

    // 5. Recalculate and sync
    return this.recalculateAndSync(cartId)
  }

  /**
   * Swap the variant of a cart item.
   * If the new variant already exists in the cart, merge (sum quantities).
   */
  private async swapVariant(
    existingItem: CartItem,
    cartId: string,
    dto: UpdateCartItemDto
  ): Promise<EnrichedCart> {
    const newVariant = await this.prisma.productVariant.findUnique({
      where: { id: dto.newProductVariantId },
      select: { id: true, sellingPrice: true, stockOnHand: true, isActive: true }
    })

    if (!newVariant) {
      throw new NotFoundException('New product variant not found')
    }

    if (!newVariant.isActive) {
      throw new BadRequestException('The selected variant is no longer available')
    }

    // Check if new variant already in cart
    const existingNewVariantItem = await this.prisma.cartItem.findUnique({
      where: {
        cartId_productVariantId: {
          cartId,
          productVariantId: dto.newProductVariantId!
        }
      }
    })

    const quantity = dto.quantity || existingItem.quantity

    if (existingNewVariantItem) {
      // Merge: sum quantities, then delete old item
      const mergedQuantity = existingNewVariantItem.quantity + quantity
      const cappedQuantity =
        newVariant.stockOnHand !== null
          ? Math.min(mergedQuantity, newVariant.stockOnHand)
          : mergedQuantity

      await this.prisma.$transaction([
        this.prisma.cartItem.update({
          where: { id: existingNewVariantItem.id },
          data: {
            quantity: cappedQuantity,
            price: newVariant.sellingPrice,
            subtotal: +newVariant.sellingPrice * cappedQuantity
          }
        }),
        this.prisma.cartItem.delete({
          where: { id: existingItem.id }
        })
      ])
    } else {
      // Simple swap: update the existing item's variant
      const cappedQuantity =
        newVariant.stockOnHand !== null ? Math.min(quantity, newVariant.stockOnHand) : quantity

      await this.prisma.cartItem.update({
        where: { id: existingItem.id },
        data: {
          productVariantId: dto.newProductVariantId,
          quantity: cappedQuantity,
          price: newVariant.sellingPrice,
          subtotal: +newVariant.sellingPrice * cappedQuantity
        }
      })
    }

    return this.recalculateAndSync(cartId)
  }

  // ==========================================
  // Remove Cart Item(s)
  // ==========================================

  /**
   * Remove a single item from cart with optimistic locking.
   */
  async removeItem(itemId: string, cartId: string, version: number): Promise<EnrichedCart> {
    await this.checkOptimisticLock(cartId, version)

    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cartId }
    })

    if (!item) {
      throw new NotFoundException('Cart item not found')
    }

    await this.prisma.cartItem.delete({ where: { id: itemId } })
    return this.recalculateAndSync(cartId)
  }

  /**
   * Remove multiple items from cart with optimistic locking (bulk delete).
   */
  async bulkRemoveItems(cartId: string, dto: BulkRemoveCartItemsDto): Promise<EnrichedCart> {
    await this.checkOptimisticLock(cartId, dto.version)

    await this.prisma.cartItem.deleteMany({
      where: {
        id: { in: dto.itemIds },
        cartId
      }
    })

    return this.recalculateAndSync(cartId)
  }

  // ==========================================
  // Cart Merging (Guest → Authenticated)
  // ==========================================

  /**
   * Merge guest cart into authenticated user's cart.
   * Strategy: Add quantities together, cap at stock limits.
   */
  async mergeGuestCart(guestCartId: string, userId: string): Promise<EnrichedCart> {
    // 1. Get guest cart items
    const guestCart = await this.prisma.cart.findUnique({
      where: { id: guestCartId },
      include: { items: true }
    })

    if (!guestCart || guestCart.items.length === 0) {
      // Nothing to merge, just return user's cart
      return this.getOrCreateCart(userId)
    }

    // 2. Get or create user cart
    let userCart = await this.prisma.cart.findUnique({
      where: { userId },
      include: { items: true }
    })

    if (!userCart) {
      userCart = await this.prisma.cart.create({
        data: {
          userId,
          totalPrice: 0
        },
        include: { items: true }
      })
    }

    // 3. Merge items
    for (const guestItem of guestCart.items) {
      const existingUserItem = userCart.items.find(
        (ui) => ui.productVariantId === guestItem.productVariantId
      )

      // Check stock for the variant
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: guestItem.productVariantId },
        select: { sellingPrice: true, stockOnHand: true, isActive: true }
      })

      if (!variant || !variant.isActive) continue

      if (existingUserItem) {
        // Sum quantities (capped at stock)
        const newQuantity = existingUserItem.quantity + guestItem.quantity
        const cappedQuantity =
          variant.stockOnHand !== null ? Math.min(newQuantity, variant.stockOnHand) : newQuantity

        await this.prisma.cartItem.update({
          where: { id: existingUserItem.id },
          data: {
            quantity: cappedQuantity,
            price: variant.sellingPrice,
            subtotal: +variant.sellingPrice * cappedQuantity
          }
        })
      } else {
        // Add new item to user's cart
        const cappedQuantity =
          variant.stockOnHand !== null
            ? Math.min(guestItem.quantity, variant.stockOnHand)
            : guestItem.quantity

        await this.prisma.cartItem.create({
          data: {
            cartId: userCart.id,
            productVariantId: guestItem.productVariantId,
            quantity: cappedQuantity,
            price: variant.sellingPrice,
            subtotal: +variant.sellingPrice * cappedQuantity
          }
        })
      }
    }

    // 4. Delete guest cart
    await this.prisma.cart.delete({ where: { id: guestCartId } })
    // await this.cartRedis.deleteCart(guestCartId)

    // 5. Recalculate and return user cart
    return this.recalculateAndSync(userCart.id)
  }

  // ==========================================
  // Get Product Variants by Product ID (for variant swap UI)
  // ==========================================

  /**
   * Get all active variants for a product (used by variant swap popover)
   */
  async getProductVariants(productId: string) {
    return this.prisma.productVariant.findMany({
      where: {
        productId,
        isActive: true
      },
      include: {
        attributeValues: {
          include: {
            attributeValue: {
              include: {
                attribute: {
                  select: { id: true, name: true }
                }
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    })
  }

  // ==========================================
  // Internal Helpers
  // ==========================================

  /**
   * Check optimistic lock version. Throws ConflictException on mismatch.
   */
  private async checkOptimisticLock(cartId: string, expectedVersion: number) {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      select: { version: true }
    })

    if (!cart) {
      throw new NotFoundException('Cart not found')
    }

    if (cart.version !== expectedVersion) {
      throw new ConflictException(
        'Cart was modified by another request. Please refresh and try again.'
      )
    }
  }

  /**
   * Recalculate cart totals, bump version, sync to Redis, and return updated cart.
   */
  private async recalculateAndSync(cartId: string): Promise<EnrichedCart> {
    // Calculate total from items
    const items = await this.prisma.cartItem.findMany({
      where: { cartId },
      select: { subtotal: true }
    })

    const totalPrice = items.reduce((sum, item) => sum + Number(item.subtotal), 0)

    // Update cart with new total and increment version
    const updatedCart = await this.prisma.cart.update({
      where: { id: cartId },
      data: {
        totalPrice,
        version: { increment: 1 }
      },
      include: CART_INCLUDE
    })

    // Sync to Redis
    const isGuest = !updatedCart.userId
    // await this.cartRedis.setCart(cartId, updatedCart, isGuest)

    return this.enrichCartWithPriceChanges(updatedCart)
  }

  /**
   * Enrich cart data with price change information.
   * Compares the snapshot price in CartItem vs the current selling price.
   */
  private enrichCartWithPriceChanges(cart: CartWithItems): EnrichedCart {
    if (!cart?.items) return { ...cart, items: [] }

    const enrichedItems: EnrichedCartItem[] = cart.items.map((item) => {
      const snapshotPrice = Number(item.price)
      const currentPrice = Number(item.productVariant?.sellingPrice || snapshotPrice)
      const priceChanged = snapshotPrice !== currentPrice

      return {
        ...item,
        priceChanged,
        previousPrice: priceChanged ? snapshotPrice : null,
        currentPrice
      }
    })

    return {
      ...cart,
      items: enrichedItems
    }
  }

  /**
   * Emit WebSocket event for authenticated users after cart mutation
   */
  notifyCartUpdated(userId: string | undefined, cart: EnrichedCart): void {
    if (userId) {
      this.cartGateway.emitCartUpdated(userId, cart)
    }
  }
}
