import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { REDIS_CLIENT } from 'database/redis/redis.module'
import Redis from 'ioredis'
import ms from 'ms'
import { v4 as uuidv4 } from 'uuid'

/**
 * OrderRedisService
 * =================
 * Handles Redis operations specific to orders:
 * - Distributed lock for preventing overselling
 * - Idempotency key storage for order creation
 *
 * Key patterns:
 * - order:lock:{variantId}           → distributed lock
 * - order:idempotency:{key}          → idempotency response cache
 */
@Injectable()
export class OrderRedisService {
  private readonly logger = new Logger(OrderRedisService.name)

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly configService: ConfigService
  ) {}

  // ==========================================
  // Distributed Lock Operations
  // ==========================================

  /**
   * Acquire a distributed lock using Redis SET NX EX.
   * Returns the lock value (UUID) on success, null on failure.
   */
  async acquireLock(key: string, ttlSeconds: number = 10): Promise<string | null> {
    const lockValue = uuidv4()
    const lockKey = `order:lock:${key}`

    try {
      const result = await this.redis.set(lockKey, lockValue, 'EX', ttlSeconds, 'NX')
      if (result === 'OK') {
        return lockValue
      }
      return null
    } catch (error) {
      this.logger.error(`Failed to acquire lock: ${lockKey}`, error)
      return null
    }
  }

  /**
   * Release a distributed lock.
   * Only releases if the lock value matches (prevents releasing someone else's lock).
   */
  async releaseLock(key: string, lockValue: string): Promise<boolean> {
    const lockKey = `order:lock:${key}`

    try {
      // Lua script for atomic check-and-delete
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `
      const result = await this.redis.eval(script, 1, lockKey, lockValue)
      return result === 1
    } catch (error) {
      this.logger.error(`Failed to release lock: ${lockKey}`, error)
      return false
    }
  }

  // ==========================================
  // Idempotency Key Operations
  // ==========================================

  /**
   * Get cached order response for an idempotency key.
   */
  async getIdempotencyResponse<T>(idempotencyKey: string): Promise<T | null> {
    try {
      const key = `order:idempotency:${idempotencyKey}`
      const data = await this.redis.get(key)
      return data ? JSON.parse(data) : null
    } catch (error) {
      this.logger.error(`Failed to get order idempotency key: ${idempotencyKey}`, error)
      return null
    }
  }

  /**
   * Store order response for an idempotency key.
   */
  async setIdempotencyResponse<T>(idempotencyKey: string, response: T): Promise<void> {
    const ttl = +ms(this.configService.get('IDEMPOTENCY__REDIS_TTL')) / 1000
    try {
      const key = `order:idempotency:${idempotencyKey}`
      await this.redis.set(key, JSON.stringify(response), 'EX', ttl)
    } catch (error) {
      this.logger.error(`Failed to set order idempotency response: ${idempotencyKey}`, error)
    }
  }
}
