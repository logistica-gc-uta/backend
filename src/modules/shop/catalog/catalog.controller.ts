import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { Role } from '../../auth/dto/register.dto.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { ShopHttpExceptionFilter } from '../shop-http.filter.js';
import { AdminCatalogQuery, CreateCatalogProductDto, CreateCategoryDto, PatchCatalogProductDto, PatchCategoryDto, PublicationDto, PublicCatalogQuery } from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';

const errorSchema: SchemaObject = { type: 'object', required: ['error'], additionalProperties: false, properties: { error: { type: 'object', required: ['code', 'message', 'details', 'requestId'], additionalProperties: false, properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' }, requestId: { type: 'string' } } } } };
const categoryMissingResponse = { description: 'CATEGORY_NOT_FOUND: category does not exist', content: { 'application/json': { schema: errorSchema, example: { error: { code: 'CATEGORY_NOT_FOUND', message: 'Category not found', details: {}, requestId: '00000000-0000-4000-8000-000000000000' } } } } };
const publicationInvalidResponse = { description: 'PRODUCT_PUBLICATION_INVALID: published product requires an active category, complete data and confirmed primary image', content: { 'application/json': { schema: errorSchema, example: { error: { code: 'PRODUCT_PUBLICATION_INVALID', message: 'Product publication requirements are not met', details: {}, requestId: '00000000-0000-4000-8000-000000000000' } } } } };
const categorySchema: SchemaObject = { type: 'object', required: ['id', 'name', 'slug', 'description', 'productCount', 'sortOrder'], additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string', nullable: true }, productCount: { type: 'integer' }, sortOrder: { type: 'integer' } } };
const adminCategorySchema: SchemaObject = { type: 'object', required: ['id', 'name', 'slug', 'description', 'isActive', 'sortOrder', 'createdAt', 'updatedAt'], additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string', nullable: true }, isActive: { type: 'boolean' }, sortOrder: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } };
const productSchema: SchemaObject = { type: 'object', required: ['id', 'sku', 'name', 'description', 'categoryId', 'category', 'priceCents', 'currency', 'stock', 'isPublished', 'isFeatured', 'isAvailable', 'images', 'primaryImageUrl', 'createdAt', 'updatedAt'], additionalProperties: false, properties: { id: { type: 'string' }, sku: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, categoryId: { type: 'string' }, category: categorySchema, priceCents: { type: 'integer' }, currency: { type: 'string', enum: ['USD'] }, stock: { type: 'integer' }, isPublished: { type: 'boolean' }, isFeatured: { type: 'boolean' }, isAvailable: { type: 'boolean' }, images: { type: 'array', maxItems: 6, items: { type: 'object', required: ['id', 'secureUrl', 'publicId', 'altText', 'position', 'isPrimary'], additionalProperties: false, properties: { id: { type: 'string' }, secureUrl: { type: 'string' }, publicId: { type: 'string' }, altText: { type: 'string' }, position: { type: 'integer' }, isPrimary: { type: 'boolean' } } } }, primaryImageUrl: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } };
const adminProductSchema: SchemaObject = { ...productSchema, properties: { ...productSchema.properties, description: { type: 'string', nullable: true }, categoryId: { type: 'string', nullable: true }, category: { ...categorySchema, nullable: true }, priceCents: { type: 'integer', nullable: true } } };
const pageSchema = (items: SchemaObject, admin = false): SchemaObject => ({ type: 'object', additionalProperties: false, required: admin ? ['items', 'total', 'page', 'pageSize', 'totalPages'] : ['items', 'total', 'page', 'pageSize', 'totalPages', 'sortApplied'], properties: { items: { type: 'array', items }, total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer', default: admin ? 10 : 12 }, totalPages: { type: 'integer' }, ...(admin ? {} : { sortApplied: { type: 'string' } }) } });

@ApiTags('Shop Public')
@UseFilters(ShopHttpExceptionFilter)
@Controller('shop')
export class PublicCatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('categories')
  @ApiOperation({ summary: 'Active categories with real published product counts' })
  @ApiResponse({ status: 200, schema: { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: categorySchema } } } })
  @ApiResponse({ status: 400, schema: errorSchema })
  categories() { return this.catalog.listCategories(true); }

  @Get('products')
  @ApiOperation({ summary: 'Published, complete products in active categories' })
  @ApiResponse({ status: 200, schema: pageSchema(productSchema) })
  @ApiResponse({ status: 400, schema: errorSchema })
  products(@Query() query: PublicCatalogQuery) { return this.catalog.listProducts(query); }

  @Get('products/:id')
  @ApiOperation({ summary: 'Public product detail' })
  @ApiResponse({ status: 200, schema: productSchema })
  @ApiResponse({ status: 404, schema: errorSchema })
  detail(@Param('id', ParseUUIDPipe) id: string) { return this.catalog.detail(id, true); }
}

@ApiTags('Admin Catalog')
@ApiBearerAuth('JWT-auth')
@ApiResponse({ status: 400, schema: errorSchema })
@ApiResponse({ status: 401, schema: errorSchema })
@ApiResponse({ status: 403, schema: errorSchema })
@ApiResponse({ status: 404, schema: errorSchema })
@ApiResponse({ status: 409, schema: errorSchema })
@UseFilters(ShopHttpExceptionFilter)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/catalog')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('categories')
  @ApiOperation({ summary: 'All categories including inactive' })
  @ApiResponse({ status: 200, schema: { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: adminCategorySchema } } } })
  categories() { return this.catalog.listCategories(false); }

  @Post('categories')
  @ApiBody({ type: CreateCategoryDto })
  @ApiResponse({ status: 201, schema: adminCategorySchema })
  @ApiResponse({ status: 409, schema: errorSchema })
  createCategory(@Body() body: CreateCategoryDto) { return this.catalog.createCategory(body); }

  @Patch('categories/:id')
  @ApiBody({ type: PatchCategoryDto })
  @ApiResponse({ status: 200, schema: adminCategorySchema })
  @ApiResponse({ status: 404, ...categoryMissingResponse })
  patchCategory(@Param('id', ParseUUIDPipe) id: string, @Body() body: PatchCategoryDto) { return this.catalog.patchCategory(id, body); }

  @Get('products')
  @ApiOperation({ summary: 'All products including unregularized legacy records' })
  @ApiResponse({ status: 200, schema: pageSchema(adminProductSchema, true) })
  products(@Query() query: AdminCatalogQuery) { return this.catalog.listAdminProducts(query); }

  @Post('products')
  @ApiBody({ type: CreateCatalogProductDto })
  @ApiResponse({ status: 201, schema: adminProductSchema })
  @ApiResponse({ status: 404, ...categoryMissingResponse })
  @ApiResponse({ status: 409, ...publicationInvalidResponse })
  createProduct(@Body() body: CreateCatalogProductDto) { return this.catalog.createProduct(body); }

  @Get('products/:id')
  @ApiResponse({ status: 200, schema: adminProductSchema })
  @ApiResponse({ status: 404, schema: errorSchema })
  detail(@Param('id', ParseUUIDPipe) id: string) { return this.catalog.detail(id, false); }

  @Patch('products/:id')
  @ApiBody({ type: PatchCatalogProductDto })
  @ApiResponse({ status: 200, schema: adminProductSchema })
  @ApiResponse({ status: 404, description: 'PRODUCT_NOT_FOUND for product or CATEGORY_NOT_FOUND for category reference', schema: errorSchema })
  @ApiResponse({ status: 409, ...publicationInvalidResponse })
  patchProduct(@Param('id', ParseUUIDPipe) id: string, @Body() body: PatchCatalogProductDto) { return this.catalog.patchProduct(id, body); }

  @Patch('products/:id/publication')
  @ApiBody({ type: PublicationDto })
  @ApiResponse({ status: 200, schema: adminProductSchema })
  @ApiResponse({ status: 409, ...publicationInvalidResponse })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() body: PublicationDto) { return this.catalog.publish(id, body.isPublished); }
}
