import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  ConfigurationError,
  corsOriginPolicy,
  loadRuntimeConfig,
  type RuntimeConfig,
} from './config/runtime-config.js';

/**
 * Prefijo, CORS, validación y Swagger según la configuración validada (#53). Lo usan el arranque real y las pruebas
 * e2e, para que lo que se prueba sea lo que se despliega.
 *
 * CORS solo gobierna a los navegadores: sin cabecera `Origin` (Flutter, servidores) no aplica y no sustituye la
 * autenticación ni la propiedad por objeto, que se siguen exigiendo en cada ruta.
 */
export function configureApp(app: INestApplication, config: RuntimeConfig): void {
  app.enableCors({ origin: corsOriginPolicy(config.corsOrigins) });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  if (!config.swaggerEnabled) return;

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Sistema de Logística y Entrega de Pedidos - UTA')
    .setDescription(
      'API REST para gestión de zonas, catálogo, órdenes y asignación de rutas de entrega con restricción de máximo 4 pedidos por repartidor.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Ingrese el token JWT Bearer',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}

/**
 * Arranque: valida la configuración ANTES de cargar la aplicación. Un error de configuración se informa con las
 * variables afectadas (nunca sus valores) y termina con código 1.
 */
export async function startApplication(env: NodeJS.ProcessEnv = process.env, logger = new Logger('Bootstrap')) {
  let config: RuntimeConfig;
  try {
    config = loadRuntimeConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    logger.error(error.message);
    return { started: false as const, exitCode: 1 };
  }
  for (const warning of config.warnings) logger.warn(warning);
  // Importación tardía: ningún módulo se carga con una configuración inválida.
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule);
  configureApp(app, config);
  await app.listen(config.port);
  logger.log(`Servidor iniciado y escuchando en el puerto ${config.port} (${config.environment})`);
  if (config.swaggerEnabled) logger.log('Documentación Swagger habilitada en /api/docs');
  return { started: true as const, exitCode: 0, app };
}
