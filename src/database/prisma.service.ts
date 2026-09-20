// src/database/prisma.service.ts
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { db } from '../prisma/db.js';

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);
    public readonly client = db;

    // Accesos directos a las lanes principales de Prisma 8
    get orm(): typeof db.orm {
        return this.client.orm;
    }

    get sql(): typeof db.sql {
        return this.client.sql;
    }

    // Accesos directos a los modelos en el namespace 'public'
    get user(): typeof db.orm.public.User {
        return this.client.orm.public.User;
    }

    get driver(): typeof db.orm.public.Driver {
        return this.client.orm.public.Driver;
    }

    get zone(): typeof db.orm.public.Zone {
        return this.client.orm.public.Zone;
    }

    get product(): typeof db.orm.public.Product {
        return this.client.orm.public.Product;
    }

    get route(): typeof db.orm.public.Route {
        return this.client.orm.public.Route;
    }

    get order(): typeof db.orm.public.Order {
        return this.client.orm.public.Order;
    }

    get orderItem(): typeof db.orm.public.OrderItem {
        return this.client.orm.public.OrderItem;
    }

    async onModuleInit() {
        this.logger.log('Prisma 8 DB Client inicializado correctamente.');
    }

    async onModuleDestroy() {
        this.logger.log('Cerrando conexiones de Prisma DB Client...');
        await this.client.close();
    }
}