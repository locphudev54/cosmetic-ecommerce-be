import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common'
import { Public } from 'core'
import { CreatePaymentDto } from 'domains/payment/dtos/create-payment.dto'
import { Request, Response } from 'express'
import { PaymentService } from './payment.service'
import { ReturnQueryFromVNPay } from 'vnpay'

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Public()
  @Post('create')
  createPayment(@Body() body: CreatePaymentDto, @Req() req: Request) {
    const ipAddr =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
      req.socket.remoteAddress ||
      '127.0.0.1'

    const paymentUrl = this.paymentService.createPaymentUrl(
      body.orderCode,
      body.orderId,
      body.amount,
      ipAddr
    )

    return { paymentUrl }
  }

  @Public()
  @Get('vnpay-return')
  async handleReturn(@Query() query: ReturnQueryFromVNPay, @Res() res: Response) {
    return this.paymentService.verifyReturn(query, res)
  }

  @Public()
  @Get('vnpay-ipn')
  async handleIpn(@Query() query: ReturnQueryFromVNPay) {
    return this.paymentService.verifyIpn(query)
  }
}
