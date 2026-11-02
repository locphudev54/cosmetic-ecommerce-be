import { IsUUID, IsNotEmpty, IsNumber, IsPositive, IsString } from 'class-validator'

export class CreatePaymentDto {
  @IsString({ message: 'Order Code must be a string' })
  @IsNotEmpty({ message: 'Order Code is required' })
  orderCode: string

  @IsUUID('4', { message: 'Order ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Order ID is required' })
  orderId: string

  @IsNumber({}, { message: 'Amount must be a number' })
  @IsPositive({ message: 'Amount must be positive' })
  amount: number
}
