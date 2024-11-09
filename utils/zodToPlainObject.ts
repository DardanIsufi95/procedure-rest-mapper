import { z, ZodTypeAny, ZodObject, ZodLiteral, ZodString, ZodNumber, ZodBoolean, ZodArray, ZodUnion, ZodOptional, ZodNullable, ZodEnum } from 'zod';

function zodToPlainObject(schema: ZodTypeAny): any {
	if (schema instanceof ZodObject) {
		const shape = schema.shape;
		const result: any = {};

		for (const key in shape) {
			result[key] = zodToPlainObject(shape[key]);
		}

		return result;
	} else if (schema instanceof ZodLiteral) {
		return schema.value;
	} else if (schema instanceof ZodString) {
		return 'string';
	} else if (schema instanceof ZodNumber) {
		return 'number';
	} else if (schema instanceof ZodBoolean) {
		return 'boolean';
	} else if (schema instanceof ZodArray) {
		return [zodToPlainObject(schema.element)];
	} else if (schema instanceof ZodUnion) {
		return schema.options.map((option: any) => zodToPlainObject(option));
	} else if (schema instanceof ZodOptional || schema instanceof ZodNullable) {
		return `${zodToPlainObject(schema.unwrap())} | ${schema instanceof ZodOptional ? 'undefined' : 'null'}`;
	} else if (schema instanceof ZodEnum) {
		return schema.options;
	}

	return 'unknown';
}

// Define a comprehensive schema
const schema = z.object({
	grant_type: z.literal('password'),
	username: z.preprocess((value) => (value ? String(value).replaceAll(/\s/g, '').toLowerCase() : undefined), z.string()),
	password: z.preprocess((value) => (value ? String(value).trim() : undefined), z.string()),
	age: z.number().optional(),
	isAdmin: z.boolean(),
	tags: z.array(z.string()),
	preferences: z.object({
		theme: z.enum(['dark', 'light']),
		notifications: z.boolean().nullable(),
	}),
	role: z.union([z.literal('user'), z.literal('admin'), z.literal('guest')]),
	scores: z.array(
		z.object({
			date: z.string(),
			score: z.number(),
		})
	),
	contact: z.union([z.object({ type: z.literal('email'), email: z.string() }), z.object({ type: z.literal('phone'), phoneNumber: z.string() })]),
	status: z.optional(z.enum(['active', 'inactive', 'pending'])),
	metadata: z.object({
		created_at: z.string().nullable(),
		updated_at: z.optional(z.string()),
	}),
});

// Convert to plain object
const plainObjectRepresentation = zodToPlainObject(schema);
console.log(plainObjectRepresentation);
