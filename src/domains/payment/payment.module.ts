import { Module } from '@nestjs/common'
import { OrdersService } from 'domains/orders/orders.service'
import { PaymentController } from './payment.controller'
import { PaymentService } from './payment.service'
import { OrdersModule } from 'domains/orders/orders.module'

@Module({
  imports: [OrdersModule],
  controllers: [PaymentController],
  providers: [PaymentService]
})
export class PaymentModule {}
