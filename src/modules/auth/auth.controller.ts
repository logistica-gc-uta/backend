import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthDtoValidationPipe } from './auth-dto-validation.pipe.js';
import { AuthService } from './auth.service.js';
import {
  AuthErrorResponseDto,
  LoginResponseDto,
  RegisterResponseDto,
} from './dto/auth-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({
    summary: 'Registro público exclusivo para CLIENT',
    description:
      'Acepta únicamente name, email y password. El nombre y correo se normalizan antes de registrar.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: 201,
    description: 'Usuario CLIENT registrado sin credenciales en la respuesta',
    type: RegisterResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR: campos inválidos o atributos no permitidos',
    type: AuthErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'EMAIL_ALREADY_EXISTS',
    type: AuthErrorResponseDto,
  })
  @HttpCode(HttpStatus.CREATED)
  // `unknown` lets the auth-local pipe own validation and its error envelope.
  async register(
    @Body(new AuthDtoValidationPipe(RegisterDto)) dto: unknown,
  ) {
    return this.authService.register(dto as RegisterDto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Inicio de sesión y obtención de JWT' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Autenticación exitosa con access_token',
    type: LoginResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
    type: AuthErrorResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'INVALID_CREDENTIALS',
    type: AuthErrorResponseDto,
  })
  @HttpCode(HttpStatus.OK)
  async login(@Body(new AuthDtoValidationPipe(LoginDto)) dto: unknown) {
    return this.authService.login(dto as LoginDto);
  }
}
