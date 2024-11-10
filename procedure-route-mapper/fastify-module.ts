import type {
	FastifyInstance,
	FastifyPluginOptions,
	FastifyRequest,
	FastifyReply,
	preParsingHookHandler,
	preHandlerHookHandler,
	onRequestHookHandler,
	onSendHookHandler,
	onResponseHookHandler,
	preValidationHookHandler,
	preSerializationHookHandler,
	onTimeoutHookHandler,
	onErrorHookHandler,
	RouteOptions,
} from 'fastify';
import fp from 'fastify-plugin';
import { expandGlob } from 'jsr:@std/fs';
import { join } from 'jsr:@std/path';

import { RequestContext } from '@fastify/request-context';
import { parse, Spec } from 'comment-parser';
import { z } from 'zod';
import vm from 'node:vm';

import { setAuthContext } from '../auth/authHandler.ts';

declare module 'fastify' {
	interface FastifyInstance {
		procedures: Procedures;
		requestData: Map<string, any>;
	}
}

type Procedure = {
	name: string;
	metadata: Spec[];
	parameters: string[];
};

type HookModule = {
	onRequest?: onRequestHookHandler;
	preParsing?: preParsingHookHandler;
	preValidation?: preValidationHookHandler;
	preHandler?: preHandlerHookHandler;
	preSerialization?: preSerializationHookHandler;
	onSend?: onSendHookHandler;
	onResponse?: onResponseHookHandler;
	onTimeout?: onTimeoutHookHandler;
	onError?: onErrorHookHandler;
	// Additional hooks can be added here
};

interface ProcedureRouteMapperConfig {
	hooksFolder: string;
	schemaName: string;
	procedureNamePrefix: string;
	guardMap: {
		[name: string]: (params: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	};
	customValidationsFolder: string; // Added for custom validation functions
}

async function registerProcedureRoutes(app: FastifyInstance, options: ProcedureRouteMapperConfig) {
	if (!app.db) {
		throw new Error('Database connection not found');
	}
	if (!app.requestContext) {
		throw new Error('Request context not found');
	}

	const [rows] = await app.db.query<any>(
		`
		SELECT
		  ROUTINE_NAME AS name,
		  ROUTINE_DEFINITION as definition,
		  CONCAT(
			'[',
			IFNULL(
			  GROUP_CONCAT('"' , PARAMETER_NAME , '"' ORDER BY ORDINAL_POSITION SEPARATOR ', '),
			  ''
			),
			']'
		  ) AS parameters
		FROM
		  INFORMATION_SCHEMA.ROUTINES r
		LEFT JOIN
		  INFORMATION_SCHEMA.PARAMETERS p ON
		  r.SPECIFIC_NAME = p.SPECIFIC_NAME AND
		  r.ROUTINE_SCHEMA = p.SPECIFIC_SCHEMA
		WHERE
		  r.ROUTINE_SCHEMA = ?
		  AND r.ROUTINE_TYPE = 'PROCEDURE'
		GROUP BY
		  ROUTINE_NAME;
		`,
		[options.schemaName]
	);

	const procedures: Procedure[] = new Array(...rows).map((procedure) => {
		return {
			name: procedure.name,
			metadata: parse(procedure.definition).flatMap((block) => block.tags),
			parameters: JSON.parse(procedure.parameters) as string[],
		};
	});

	const hooks = await loadHooks(options.hooksFolder);

	const validations = await loadCustomValidations(options.customValidationsFolder);

	const schemaParser = new ZodSchemaParser(validations);

	// Create an instance of Procedures and decorate the app with it
	app.decorate('procedures', new Procedures(procedures, app));

	for (const procedure of procedures) {
		try {
			const metadata = procedure.metadata;
			const hookTags = metadata.filter((tag) => tag.tag === 'hooks');

			const routeHooks: { [key: string]: Function[] } = {};

			const allowedHookTypes = ['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onResponse', 'onTimeout', 'onError'];

			for (const hookTag of hookTags) {
				const hookType = hookTag.name;
				const functionsString = hookTag.description;
				if (!hookType || !functionsString) {
					throw new Error(`Invalid @hooks tag format in procedure ${procedure.name}`);
				}
				if (routeHooks[hookType]) {
					throw new Error(`Multiple declarations of the same hookType '${hookType}' in procedure ${procedure.name}`);
				}
				if (!allowedHookTypes.includes(hookType)) {
					throw new Error(`Invalid hookType '${hookType}' in procedure ${procedure.name}. Allowed hook types are: ${allowedHookTypes.join(', ')}`);
				}
				const functionNames = functionsString.split(',').map((fn) => fn.trim());
				routeHooks[hookType] = functionNames.map((fnName) => {
					const hookFunction = hooks[fnName];
					if (!hookFunction) {
						throw new Error(`Hook function '${fnName}' not found in hooks module for procedure ${procedure.name}`);
					}
					return hookFunction;
				});
			}

			const [method, url] = parseProcedureName(procedure.name, options.procedureNamePrefix);

			console.log(`Registering route: ${method} ${url}`);

			const schema = generateZodSchema(procedure, metadata, schemaParser);

			const guards = generateGuards(procedure, metadata, options.guardMap);

			const procedureParamMetadata = getParamMetadata(metadata);

			const routeOptions: RouteOptions = {
				method,
				url,
				preValidation: [setAuthContext, ...guards],
				preHandler: [],
				onRequest: [],
				preParsing: [],
				preSerialization: [],
				onSend: [],
				onResponse: [],
				onTimeout: [],
				onError: [],
				handler: async (request, reply) => {
					try {
						const [results, resultMetadata] = await app.procedures.executef(procedure.name, request);

						if (!resultMetadata) {
							return results;
						}

						reply.status(resultMetadata.status ? resultMetadata.status : resultMetadata.error ? 400 : 200);

						if (resultMetadata.error) {
							return {
								error: !!resultMetadata.error,
								success: !!resultMetadata.success,
								message: resultMetadata.message,
							};
						}

						return results;
					} catch (error: any) {
						console.error(error);
						const errorMessage = `Error in handler for procedure ${procedure.name}: ${error.message}`;
						throw new Error(errorMessage);
					}
				},
				schema,
			};

			for (const [hookType, hookFunctions] of Object.entries(routeHooks)) {
				(routeOptions as any)[hookType]?.push(...hookFunctions);
			}
			app.route(routeOptions);
		} catch (error: any) {
			const errorMessage = `Error in procedure ${procedure.name}: ${error.message}`;
			throw new Error(errorMessage);
		}
	}
}

function parseProcedureName(procedureName: string, procedureNamePrefix: string = 'api_') {
	const nameWithoutPrefix = procedureName.replace(procedureNamePrefix, '');
	const [methodPart, ...urlParts] = nameWithoutPrefix.split('_');
	const method = methodPart.toUpperCase();
	const url = urlParts
		.join('_')
		.replace(/__/g, '/')
		.replace(/_/g, '-')
		.replace(/\.(\w+)\./g, ':$1');

	return [method, `/${url}`];
}

function generateZodSchema(procedure: Procedure, metadata: Spec[], parser: ZodSchemaParser) {
	const schema: {
		querystring?: z.ZodObject<any>;
		params?: z.ZodObject<any>;
		body?: z.ZodObject<any>;
		headers?: z.ZodObject<any>;
	} = {};

	for (const tag of metadata) {
		if (tag.tag === 'param') {
			const match = tag.name.match(/(\w+)<(\w+)>/);
			const name = match ? match[1] : tag.name;
			const alias = match ? match[2] : tag.name;

			let schemaPart: z.ZodAny;

			try {
				schemaPart = parser.parse(tag.description);
			} catch (error: any) {
				throw new Error(`Error parsing schema for parameter ${name} in procedure ${procedure.name}: ${error.message}`);
			}

			switch (tag.type) {
				case 'querystring':
					if (!schema.querystring) {
						schema.querystring = z.object({});
					}
					schema.querystring = schema.querystring.extend({
						[alias]: schemaPart,
					});
					break;
				case 'body':
					if (!schema.body) {
						schema.body = z.object({});
					}
					schema.body = schema.body.extend({
						[alias]: schemaPart,
					});
					break;
				case 'params':
					if (!schema.params) {
						schema.params = z.object({});
					}
					schema.params = schema.params.extend({
						[alias]: schemaPart,
					});
					break;
				case 'headers':
					if (!schema.headers) {
						schema.headers = z.object({});
					}
					schema.headers = schema.headers.extend({
						[alias]: schemaPart,
					});
					break;
				case 'user':
					// Do nothing
					break;
				case 'request':
					// Do nothing
					break;
				default:
					//console.log(tag);
					throw new Error(`Unknown parameter type: ${tag.type} for parameter: ${tag.name}`);
			}
		}
	}

	return schema;
}

class ZodSchemaParser {
	private context: vm.Context;
	constructor(validations: { [name: string]: () => z.ZodTypeAny }) {
		this.context = this.createRestrictedContext(validations);
	}

	private createRestrictedContext(validations: { [name: string]: () => z.ZodTypeAny }) {
		const sandbox = {
			z: z, // Expose only the 'z' object
			c: validations, // Expose custom validations as 'c'
		};

		// Create a secure context
		const context = vm.createContext(sandbox, {
			name: 'zod-sandbox',
			origin: 'zod-sandbox',
		});

		// Remove dangerous globals
		const unsafeGlobals = [
			'process',
			'require',
			'global',
			'globalThis',
			'module',
			'exports',
			'Buffer',
			'setImmediate',
			'setInterval',
			'setTimeout',
			'clearImmediate',
			'clearInterval',
			'clearTimeout',
		];

		unsafeGlobals.forEach((prop) => {
			vm.runInContext(`delete this.${prop}`, context);
		});

		return context;
	}

	parse(string: string) {
		try {
			const script = new vm.Script(string);
			const schema = script.runInContext(this.context);
			return schema;
		} catch (error: any) {
			throw new Error(`Error parsing Zod schema: ${error.message} in schema: ${string}`);
		}
	}
}

function generateGuards(
	procedure: Procedure,
	metadata: Spec[],
	guardMap: {
		[name: string]: (params: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	}
) {
	return metadata
		.filter((tag) => tag.tag === 'guard')
		.map((guard) => {
			if (!guardMap[guard.name]) {
				throw new Error(`Guard not found: ${guard.name} in procedure: ${procedure.name}`);
			}
			const params = guard.description ? guard.description.split(',').map((param) => param.trim()) : [];
			return guardMap[guard.name](params);
		});
}

function getParamMetadata(metadata: Spec[]) {
	const allowedGetFromValues = ['querystring', 'params', 'body', 'headers', 'user', 'request'];
	return metadata.reduce((acc, tag) => {
		if (tag.tag === 'param') {
			const match = tag.name.match(/(\w+)<(\w+)>/);
			const name = match ? match[1] : tag.name;
			const alias = match ? match[2] : tag.name;

			if (!allowedGetFromValues.includes(tag.type)) {
				throw new Error(`Invalid getFrom value: ${tag.type} for parameter: ${name}`);
			}

			acc[name] = {
				name,
				alias,
				getFrom: tag.type,
				description: tag.description,
			};
		}
		return acc;
	}, {} as { [name: string]: { name: string; alias: string; getFrom: string; description: string } });
}

async function loadProcedureHooksMap(hooksFolder: string) {
	const hooks: { [name: string]: HookModule } = {};

	for await (const file of expandGlob(`${join(Deno.cwd(), hooksFolder)}/**/*.ts`)) {
		try {
			const moduleUrl = new URL(`file://${file.path}`);
			const module: HookModule = await import(moduleUrl.href);

			const name = moduleUrl.pathname.split('/').pop()?.replace('.ts', '');
			if (!name) {
				throw new Error(`Cannot determine the module name from file path: ${moduleUrl.pathname}`);
			}

			hooks[name] = module;
		} catch (error: any) {
			throw new Error(`Error loading hook module from file ${file.path}: ${error.message}`);
		}
	}

	return hooks;
}

async function loadHooks(hooksFolder: string): Promise<{ [name: string]: Function }> {
	const hooks: { [name: string]: Function } = {};

	for await (const file of expandGlob(`${join(Deno.cwd(), hooksFolder)}/**/*.ts`)) {
		try {
			const moduleUrl = new URL(`file://${file.path}`);
			const module = await import(moduleUrl.href);

			Object.entries(module).forEach(([name, fn]) => {
				if (hooks[name]) {
					throw new Error(`Duplicate hook function name: ${name} in ${moduleUrl.href}`);
				}
				if (typeof fn !== 'function') {
					throw new Error(`Exported member '${name}' in ${moduleUrl.href} is not a function`);
				}
				hooks[name] = fn;
			});
		} catch (error: any) {
			throw new Error(`Error loading hook module from file ${file.path}: ${error.message}`);
		}
	}

	return hooks;
}

async function loadCustomValidations(customValidationsFolder: string): Promise<{ [name: string]: () => z.ZodTypeAny }> {
	const validations: { [name: string]: () => z.ZodTypeAny } = {};

	for await (const file of expandGlob(`${join(Deno.cwd(), customValidationsFolder)}/**/*.ts`)) {
		try {
			const moduleUrl = new URL(`file://${file.path}`);
			const module = await import(moduleUrl.href);

			const moduleName = moduleUrl.pathname.split('/').pop()?.replace('.ts', '');
			if (!moduleName) {
				throw new Error(`Cannot determine the module name from file path: ${moduleUrl.pathname}`);
			}

			if (module.default) {
				if (validations[moduleName]) {
					throw new Error(`Duplicate validation function name: ${moduleName}`);
				}
				const validationFunction = module.default;

				if (typeof validationFunction !== 'function') {
					throw new Error(`Validation module ${moduleName} does not export a function`);
				}

				const testSchema = validationFunction();
				if (!(testSchema instanceof z.ZodType)) {
					throw new Error(`Validation function ${moduleName} does not return a Zod schema`);
				}
				validations[moduleName] = validationFunction;
			} else {
				Object.entries(module).forEach(([name, validationFunction]) => {
					if (validations[name]) {
						throw new Error(`Duplicate validation function name: ${name}@${moduleName}`);
					}

					if (typeof validationFunction !== 'function') {
						throw new Error(`Validation module ${name}@${moduleName} is not a function`);
					}

					const testSchema = validationFunction();
					if (!(testSchema instanceof z.ZodType)) {
						throw new Error(`Validation function ${name}@${moduleName} does not return a Zod schema`);
					}
					validations[name] = validationFunction as () => z.ZodTypeAny;
				});
			}
			return validations;
		} catch (error: any) {
			throw new Error(`Error loading validation module from file ${file.path}: ${error.message}`);
		}
	}

	return validations;
}

class Procedures {
	private procedures: Map<string, Procedure>;
	private app: FastifyInstance;
	constructor(procedures: Procedure[], app: FastifyInstance) {
		this.procedures = new Map(procedures.map((p) => [p.name, p]));
		this.app = app;
	}

	async execute(procedureName: string, request: FastifyRequest): Promise<[any, any]> {
		const procedure = this.procedures.get(procedureName);
		if (!procedure) {
			throw new Error(`Procedure not found: ${procedureName}`);
		}

		const procedureParamMetadata = getParamMetadata(procedure.metadata);

		const procedureParams = procedure.parameters.map((param) => {
			const paramMeta = procedureParamMetadata[param];
			if (!paramMeta) {
				throw new Error(`Parameter metadata not found for parameter: ${param} in procedure: ${procedure.name}`);
			}

			let value;
			switch (paramMeta.getFrom) {
				case 'querystring':
					value = (request.query as any)[paramMeta.alias];
					break;
				case 'params':
					value = (request.params as any)[paramMeta.alias];
					break;
				case 'body':
					value = (request.body as any)[paramMeta.alias];
					break;
				case 'headers':
					value = request.headers[paramMeta.alias];
					break;
				case 'user':
					//@ts-ignore
					value = request.requestContext.get('user')?.[paramMeta.alias];
					break;
				case 'request':
					value = request.requestData.get(paramMeta.alias);
					break;
				default:
					throw new Error(`Unknown getFrom value: ${paramMeta.getFrom} for parameter: ${param} in procedure: ${procedure.name}`);
			}

			if (value === undefined || value === null) {
				return null;
			}

			if (Array.isArray(value) || typeof value === 'object') {
				return JSON.stringify(value);
			}

			return value;
		});

		const sql = `CALL \`${procedure.name}\`(${procedureParams.map(() => '?').join(', ')})`;
		const dbResponse = await this.app.db.query(sql, procedureParams);

		const results = dbResponse[0] as any;

		if (!Array.isArray(results)) {
			return [results, null];
		}

		const info = results.pop();

		const resultMetadata = results?.[0]?.[0]?.['#RESULT#'] ? results.shift()?.[0] : null;

		return [results, resultMetadata];
	}

	async executef(procedureName: string, request: FastifyRequest): Promise<[any, any]> {
		return await this.execute(procedureName, request).then(([results, resultMetadata]) => {
			const resultSchema = resultMetadata?.schema?.split(',') as string[] | undefined;

			if (!resultSchema && resultMetadata.error) {
				return {
					error: !!resultMetadata.error,
					success: !!resultMetadata.success,
					message: resultMetadata.message,
				};
			}

			if (!resultSchema && !resultMetadata.error) {
				return results;
			}

			const preparedResult = resultSchema!.map((type, index) => {
				if (type === 'object') {
					return results[index][0];
				} else {
					return results[index];
				}
			});

			if (preparedResult.length === 1) {
				return [preparedResult[0], resultMetadata];
			} else {
				return [preparedResult, resultMetadata];
			}
		});
	}
}

export default fp(registerProcedureRoutes);
