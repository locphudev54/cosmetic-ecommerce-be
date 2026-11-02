import { Type } from 'class-transformer'
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested
} from 'class-validator'
import { PaymentMethod } from 'enums'

export class ShippingInfoDto {
  @IsString()
  @IsNotEmpty({ message: 'Full name is required' })
  @MaxLength(255)
  fullName: string

  @IsEmail({}, { message: 'Email must be a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string

  @IsString()
  @IsNotEmpty({ message: 'Phone number is required' })
  @MaxLength(20)
  phoneNumber: string

  @IsString()
  @IsNotEmpty({ message: 'Province is required' })
  province: string

  @IsString()
  @IsNotEmpty({ message: 'District is required' })
  district: string

  @IsString()
  @IsNotEmpty({ message: 'Ward is required' })
  ward: string

  @IsString()
  @IsOptional()
  streetAddress?: string

  @IsString()
  @IsOptional()
  note?: string
}

export class CreateOrderDto {
  @IsUUID('4', { message: 'Cart ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Cart ID is required' })
  cartId: string

  @IsArray()
  @IsUUID('4', { each: true, message: 'Each selected item ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Selected item IDs are required' })
  selectedCartItemIds: string[]

  @IsEnum(PaymentMethod, { message: 'Payment method must be COD or BANKING' })
  @IsNotEmpty({ message: 'Payment method is required' })
  paymentMethod: PaymentMethod

  @ValidateNested()
  @Type(() => ShippingInfoDto)
  @IsNotEmpty({ message: 'Shipping info is required' })
  shippingInfo: ShippingInfoDto

  @IsNumber()
  @Min(0)
  @IsOptional()
  shippingFee?: number
}
