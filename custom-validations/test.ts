import { z } from 'zod';

export const PasswordSchema = () => z.string().min(5, 'Password must be at least 5 characters long');
