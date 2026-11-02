import { Controller, Get, Inject, Logger } from '@nestjs/common'
import { AppService } from 'app.service'
import { Public } from 'core/decorators/public.decorator'
@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name)

  constructor(
    @Inject() private readonly appService: AppService // private readonly mailerService: MailerService
  ) {}

  @Public()
  @Get()
  async getHello() {
    this.logger.log('Hello endpoint called')
    return { name: 'LOc' }
    return this.appService.getHello()
  }

  @Public()
  @Get('test-email')
  async testEmail() {
    // await this.mailerService.sendWelcomeEmail('test@example.com', 'Pham Phu Loc')
  }
}
