import '@std/dotenv/load';
import type { PoolOptions } from 'npm:mysql2/promise';
import { z } from 'zod';

interface DatabaseConfig extends PoolOptions {}

interface Config {
	database: DatabaseConfig;
	procedurePrefix: string;
	serverPort: number;
	jwt: {
		secret: string;
		refreshSecret: string;
		expiresIn: string;
		refresExpiresIn?: string;
	};
}

const configschema = z.object({
	database: z.object({
		host: z.string(),
		user: z.string(),
		port: z.number(),
		password: z.string(),
		database: z.string(),
		namedPlaceholders: z.boolean(),
		connectionLimit: z.number(),
	}),
	procedurePrefix: z.string(),
	serverPort: z.number(),
	jwt: z.object({
		secret: z.string(),
		refreshSecret: z.string(),
		expiresIn: z.string(),
		refresExpiresIn: z.string().optional(),
	}),
});

const config: Config = {
	database: {
		host: Deno.env.get('DB_HOST')! as string,
		user: Deno.env.get('DB_USER')!,
		port: parseInt(Deno.env.get('DB_PORT')!),
		password: Deno.env.get('DB_PASS')!,
		database: Deno.env.get('DB_NAME')!,
		namedPlaceholders: true,
		connectionLimit: 10,
	},
	procedurePrefix: Deno.env.get('PROC_PREFIX') || 'api',
	serverPort: parseInt(Deno.env.get('PORT') || '3000', 10),
	jwt: {
		secret: Deno.env.get('JWT_SECRET')!,
		refreshSecret: Deno.env.get('JWT_REFRESH_SECRET')!,
		expiresIn: Deno.env.get('JWT_EXPIRES_IN')!,
		refresExpiresIn: Deno.env.get('JWT_REFRESH_EXPIRES_IN'),
	},
};
configschema.parse(config);
export default config;
