/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

// Controllers
import { ConfigurationController } from './controllers/ConfigurationController';
import { LocaleController } from './controllers/LocaleController';
import { CryptController } from './controllers/CryptController';
import { ModuleConfigController } from './controllers/ModuleConfigController';
import { EmailController } from './controllers/EmailController';
import { BugReportController } from './controllers/BugReportController';
import { SystemInfoController } from './controllers/SystemInfoController';
import { ThemeController } from './controllers/ThemeController';
import { CookieConsentController } from './controllers/CookieConsentController';
import { DonationController } from './controllers/DonationController';
import { HealthController } from './controllers/HealthController';
import { EventStreamController } from './event-stream/EventStreamController';

// Services
import { ConfigurationService } from './services/ConfigurationService';
import { LocaleService } from './services/LocaleService';
import { ProwlService } from './services/ProwlService';
import { CryptService } from './services/CryptService';
import { RedisService } from './services/RedisService';
import { EventStreamService } from './event-stream/EventStreamService';
import { RemoteEventFeedPollerService } from './events/RemoteEventFeedPollerService';
import { CryptSessionService } from './services/CryptSessionService';
import { TransportCryptInterceptor } from './interceptors/TransportCryptInterceptor';
import { CacheControlInterceptor } from './interceptors/CacheControlInterceptor';
import { ConfigSeederService } from './services/ConfigSeederService';
import { ModuleConfigRegistry } from './services/ModuleConfigRegistry';
import { ModuleConfigService } from './services/ModuleConfigService';
import { ModuleConfigSeederService } from './services/ModuleConfigSeederService';
import { EmailService } from './services/EmailService';
import { EmailConfigRegistration } from './services/EmailConfigRegistration';
import { BrandService } from './services/BrandService';
import { EmailLayoutService } from './services/EmailLayoutService';
import { MailjetProviderClient } from './services/providers/MailjetProviderClient';
import { BrevoProviderClient } from './services/providers/BrevoProviderClient';
import { EmailProviderService } from './services/providers/EmailProviderService';
import { CommonConfigRegistration } from './services/CommonConfigRegistration';
import { SystemInfoService } from './services/SystemInfoService';
import { CronLockService } from './services/CronLockService';
import { InstanceRoleService } from './services/InstanceRoleService';
import { ThemeService } from './services/ThemeService';
import { TelegramService } from './services/TelegramService';
import { DiskAlertService } from './services/DiskAlertService';
import { ImageStorageService } from './services/ImageStorageService';
import { CookieConsentService } from './services/CookieConsentService';
import { CookieConsentRetentionCronService } from './services/CookieConsentRetentionCronService';
import { DonationService } from './services/DonationService';
import { DonationPriceService } from './services/DonationPriceService';
import { ThemeEntity } from './entities/ThemeEntity';
import { CookieConsentEntity } from './entities/CookieConsentEntity';

// Rate limiting
import { CommonThrottlerGuard, ThrottleRegistry, throttleProviders } from './throttle';

// Exceptions
import { AppExceptionFilter } from './exceptions/AppExceptionFilter';

// Mappers
import { ConfigurationMapper } from './mappers/ConfigurationMapper';
import ConfigurationEntity from './entities/ConfigurationEntity';

@Module({
  imports: [TypeOrmModule.forFeature([ConfigurationEntity, ThemeEntity, CookieConsentEntity])],
  controllers: [ConfigurationController, LocaleController, CryptController, ModuleConfigController, EmailController, BugReportController, SystemInfoController, ThemeController, CookieConsentController, DonationController, HealthController, EventStreamController],
  providers: [
    ConfigurationService,
    ConfigSeederService,
    ConfigurationMapper,
    LocaleService,
    ProwlService,
    CryptService,
    RedisService,
    EventStreamService,
    RemoteEventFeedPollerService,
    CryptSessionService,
    TransportCryptInterceptor,
    CacheControlInterceptor,
    ModuleConfigRegistry,
    ModuleConfigService,
    ModuleConfigSeederService,
    EmailService,
    EmailConfigRegistration,
    BrandService,
    EmailLayoutService,
    MailjetProviderClient,
    BrevoProviderClient,
    EmailProviderService,
    CommonConfigRegistration,
    SystemInfoService,
    CronLockService,
    InstanceRoleService,
    ThemeService,
    TelegramService,
    DiskAlertService,
    ImageStorageService,
    CookieConsentService,
    CookieConsentRetentionCronService,
    DonationService,
    DonationPriceService,
    AppExceptionFilter,
    ...throttleProviders,
    ThrottleRegistry,
    CommonThrottlerGuard,
    {
      // Pass-through unless `common_throttleEnabled` is true (off by default: apps with their own limiter).
      provide: APP_GUARD,
      useExisting: CommonThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useExisting: AppExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useExisting: TransportCryptInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useExisting: CacheControlInterceptor,
    },
  ],
  exports: [
    ConfigurationService,
    ConfigSeederService,
    ConfigurationMapper,
    LocaleService,
    ProwlService,
    CryptService,
    RedisService,
    EventStreamService,
    RemoteEventFeedPollerService,
    CryptSessionService,
    ModuleConfigRegistry,
    ModuleConfigService,
    ModuleConfigSeederService,
    EmailService,
    BrandService,
    EmailLayoutService,
    EmailProviderService,
    CronLockService,
    InstanceRoleService,
    ThemeService,
    TelegramService,
    DiskAlertService,
    ImageStorageService,
    AppExceptionFilter,
    ThrottleRegistry,
  ],
})
export class CommonModule {}

export { IdParamDto } from './dtos/IdParamDto';
export * from './types/ModuleConfigSchema';
export { ModuleConfigRegistry } from './services/ModuleConfigRegistry';
export { ModuleConfigService } from './services/ModuleConfigService';

export * from './auth';
export * from './plugins';
export * from './event-stream';
