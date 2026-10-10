import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import postgres from '@prisma/orm-postgres/runtime';
import type { Contract } from '../src/prisma/contract.d';
import contractJson from '../src/prisma/contract.json' with { type: 'json' };
import {
  createOwnedDatabase,
  runPrismaMigrate,
  execPsqlCommand,
} from './geolocation-migration.fixtures.js';
import { ASSIGNMENT_FIXTURE } from './route-assignment.fixtures.js';

export async function historyHost(legacy = '') {
  const database = `history_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const url = createOwnedDatabase(database);
  runPrismaMigrate(
    url,
    '46fa53371d5e324c936c448652fedcf104429400542c3159e5551c01e9210452',
  );
  execPsqlCommand(database, ASSIGNMENT_FIXTURE + legacy);
  runPrismaMigrate(url);
  const db = postgres<Contract>({ contractJson, url });
  const secret = randomUUID();
  process.env.JWT_SECRET = secret;
  const { AppModule } = await import('../src/app.module.js');
  const { PrismaService } = await import('../src/database/prisma.service.js');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({
      client: db,
      orm: db.orm,
      sql: db.sql,
      user: db.orm.public.User,
      driver: db.orm.public.Driver,
      route: db.orm.public.Route,
      order: db.orm.public.Order,
      zone: db.orm.public.Zone,
      product: db.orm.public.Product,
    })
    .compile();
  const app: INestApplication = module.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  const jwt = new JwtService({ secret });
  const token = (sub = 'admin', role = 'ADMIN') =>
    jwt.sign({ sub, role, email: `${sub}@fixture.invalid` });
  return { app, db, database, token };
}
