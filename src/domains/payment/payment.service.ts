import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { OrdersService } from 'domains/orders/orders.service'
import { OrderStatus, PaymentResult } from 'enums'
import { Response } from 'express'
import { VNPay, ignoreLogger, ProductCode, VnpLocale, ReturnQueryFromVNPay } from 'vnpay'

@Injectable()
export class PaymentService {
  private vnpay: VNPay

  constructor(
    private config: ConfigService,
    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService
  ) {
    this.vnpay = new VNPay({
      tmnCode: this.config.get<string>('VNPAY_TMN_CODE'),
      secureSecret: this.config.get<string>('VNPAY_HASH_SECRET'),
      vnpayHost: this.config.get<string>('VNPAY_HOST'),
      loggerFn: ignoreLogger
    })
  }

  createPaymentUrl(orderCode: string, orderId: string, amount: number, ipAddr: string): string {
    return this.vnpay.buildPaymentUrl({
      vnp_Amount: amount,
      vnp_IpAddr: ipAddr,
      vnp_TxnRef: orderCode,
      vnp_OrderInfo: `${orderId}`,
      vnp_OrderType: ProductCode.Other,
      vnp_ReturnUrl: this.config.get<string>('VNPAY_RETURN_URL'),
      vnp_Locale: VnpLocale.VN
    })
  }

  async verifyReturn(query: ReturnQueryFromVNPay, res: Response) {
    const verifyResult = this.vnpay.verifyReturnUrl(query)
    const frontendUrl = this.configService.get('cors.origin')

    if (!verifyResult.isVerified) {
      return res.redirect(
        `${frontendUrl}/payment?result=${PaymentResult.FAILED}&orderCode=${query.vnp_TxnRef}`
      )
    }

    if (verifyResult.isSuccess) {
      const orderId = query.vnp_OrderInfo
      await this.ordersService.updateOrderStatus(orderId, OrderStatus.PAID)
      return res.redirect(
        `${frontendUrl}/payment?result=${PaymentResult.SUCCESS}&orderCode=${query.vnp_TxnRef}`
      )
    }

    return res.redirect(
      `${frontendUrl}/payment?result=${PaymentResult.FAILED}&orderCode=${query.vnp_TxnRef}`
    )
  }

  async verifyIpn(query: ReturnQueryFromVNPay) {
    const verifyResult = this.vnpay.verifyIpnCall(query as unknown as ReturnQueryFromVNPay)
    if (!verifyResult.isVerified) {
      return { RspCode: '97', Message: 'Invalid signature' }
    }
    if (!verifyResult.isSuccess) {
      return { RspCode: '00', Message: 'Confirm Success' } // still ack to VNPay
    }

    await this.ordersService.updateOrderStatus(query.vnp_TxnRef, OrderStatus.PAID)
    return { RspCode: '00', Message: 'Confirm Success' }
  }
}
