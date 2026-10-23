import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { PrismaModule } from '../../../database/prisma.module.js';
import { CloudinaryUploadProvider, UPLOAD_PROVIDER } from './upload-provider.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Injectable()
export class UploadCleanupJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadCleanupJob.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly uploads: UploadsService) {}
  onModuleInit() {
    if (process.env.CATALOG_UPLOAD_CLEANUP_ENABLED !== 'true' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Bound each tick; another tick handles remaining assets after their lease expires.
      for (let i = 0; i < 10; i++) if (!await this.uploads.cleanupOnce()) break;
    } catch { this.logger.warn('Upload cleanup pending retry'); }
    finally { this.running = false; }
  }
}

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [UploadsController],
  providers: [UploadsService, UploadCleanupJob, { provide: UPLOAD_PROVIDER, useClass: CloudinaryUploadProvider }],
  exports: [UploadsService],
})
export class UploadsModule {}
