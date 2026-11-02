export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
  STAFF = 'STAFF'
}

export enum CategoryTreeFormat {
  NESTED = 'nested',
  FLAT = 'flat'
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc'
}

export enum ProductSortBy {
  CREATED_AT = 'createdAt',
  NAME = 'name',
  PRICE = 'basePrice',
  VIEWS = 'views'
}

export enum CategorySortBy {
  NAME = 'name',
  SLUG = 'slug',
  CREATED_AT = 'createdAt',
  PARENT_CATEGORY_NAME = 'parentCategoryName',
  PRODUCT_COUNT = 'productCount',
  DEPTH = 'depth'
}

export enum CollectionSortBy {
  TITLE = 'title',
  SLUG = 'slug',
  CREATED_AT = 'createdAt',
  PRODUCT_COUNT = 'productCount'
}

export enum PaginationType {
  OFFSET = 'offset',
  CURSOR = 'cursor'
}

export enum ProductStatus {
  PUBLISHED = 'PUBLISHED',
  DRAFT = 'DRAFT',
  ARCHIVED = 'ARCHIVED'
}

export enum OrderStatus {
  PROCESSING = 'PROCESSING',
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  PACKED = 'PACKED',
  READY_TO_SHIP = 'READY_TO_SHIP',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  RETURNED = 'RETURNED'
}

export enum PaymentMethod {
  COD = 'COD',
  BANKING = 'BANKING'
}

export enum OrderSortBy {
  CREATED_AT = 'createdAt',
  TOTAL_PRICE = 'totalPrice',
  STATUS = 'status',
  CODE = 'code'
}

export enum PaymentResult {
  SUCCESS,
  FAILED,
  PENDING
}
