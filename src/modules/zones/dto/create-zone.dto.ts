import { IsNotEmpty, IsString } from 'class-validator';

export class CreateZoneDto {
  @IsString({ message: 'El nombre de la zona debe ser texto' })
  @IsNotEmpty({ message: 'El nombre de la zona es obligatorio' })
  name!: string;

  @IsString({ message: 'El código de la zona debe ser texto' })
  @IsNotEmpty({ message: 'El código de la zona es obligatorio' })
  code!: string;
}
