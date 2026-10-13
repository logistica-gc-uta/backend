import { Global, Module } from '@nestjs/common';
import { REALTIME_PUBLISHER } from './realtime.contract.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

@Global()
@Module({
  providers: [
    RealtimeService,
    RealtimeGateway,
    { provide: REALTIME_PUBLISHER, useExisting: RealtimeService },
  ],
  exports: [REALTIME_PUBLISHER, RealtimeGateway],
})
export class GlobalRealtimeModule {}
