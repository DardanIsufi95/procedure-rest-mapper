import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'npm:fastify';
import fp from 'npm:fastify-plugin';

import { ProcedureRouteMapperConfig } from './interfaces.ts';
import { RequestContext } from 'npm:@fastify/request-context';
import { parse, Spec } from 'npm:comment-parser';
import { z } from 'npm:zod';
import vm from 'node:vm';
import { ZodTypeProvider } from 'npm:fastify-type-provider-zod';

import { setAuthContext } from '../auth/authHandler.ts';

import { requireAuth, requireRole, requirePremission } from '../auth/authGuards.ts';

type Procedure = {
	name: string;
	definition: string;
	parameters: string[];
};

async function registerProcedureRoutes(app: FastifyInstance, options: ProcedureRouteMapperConfig) {
	if (!app.db) {
		throw new Error('Database connection not found');
	}
	if (!app.requestContext) {
		throw new Error('Request context not found');
	}

	const [rows] = await app.db.query<any>(/*sql*/ `
		SELECT
			ROUTINE_NAME AS name,
			ROUTINE_DEFINITION as definition,
			CONCAT('[', 
				IFNULL(
								
					GROUP_CONCAT('"' , PARAMETER_NAME , '"' ORDER BY ORDINAL_POSITION SEPARATOR ', '),
					'' -- Returns an empty array if there are no parameters
				), 
			']') AS parameters
		FROM
			INFORMATION_SCHEMA.ROUTINES r
		LEFT JOIN
			INFORMATION_SCHEMA.PARAMETERS p
		ON
			r.SPECIFIC_NAME = p.SPECIFIC_NAME
			AND r.ROUTINE_SCHEMA = p.SPECIFIC_SCHEMA
		WHERE
			r.ROUTINE_SCHEMA = 'test'
			AND r.ROUTINE_TYPE = 'PROCEDURE'
		GROUP BY
			ROUTINE_NAME;

	`);

	const procedures: Procedure[] = new Array(...rows).map((procedure) => {
		return {
			name: procedure.name,
			definition: procedure.definition,
			parameters: JSON.parse(procedure.parameters) as string[],
		};
	});
	for (const procedure of procedures) {
		const metadata = parse(procedure.definition).flatMap((block) => block.tags);
		const [method, url] = parseProcedureName(procedure.name);

		const schema = generateZodSchema(procedure, metadata, new ZodSchemaParser());

		const guards = generateGuards(procedure, metadata, {
			auth: requireAuth,
			role: requireRole,
			premission: requirePremission,
		});

		const procedureParamMetadata = getParamMetadata(metadata);

		app.addHook('preValidation', setAuthContext);
		app.withTypeProvider<ZodTypeProvider>().route({
			method: method,
			url: url,
			preValidation: [...guards],
			handler: async (request, reply) => {
				const procedureParams = procedure.parameters.map((param) => {
					switch (procedureParamMetadata[param].getFrom) {
						case 'querystring':
							return (request.query as any)[procedureParamMetadata[param].alias];
						case 'params':
							return (request.params as any)[procedureParamMetadata[param].alias];
						case 'body':
							return (request.body as any)[procedureParamMetadata[param].alias];
						case 'headers':
							return request.headers[procedureParamMetadata[param].alias];
						case 'user':
							return request.requestContext.get('user')?.[procedureParamMetadata[param].alias];
						default:
							return null;
					}
				});

				const [results] = await app.db.query(`CALL ${procedure.name}(${procedure.parameters.map(() => '?').join(', ')})`, procedureParams);

				const info = (results as any[]).pop();

				const resultMetadata = (results as any[])?.[0]?.[0]?.['#RESULT#'] ? (results as any[]).shift()[0] : null;

				if (!resultMetadata) {
					return results;
				}

				reply.status(resultMetadata.status ? resultMetadata.status : resultMetadata.error ? 400 : 200);

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
						return (results as any)[index][0];
					} else {
						return (results as any)[index];
					}
				});

				if (preparedResult.length === 1) {
					return preparedResult[0];
				} else {
					return preparedResult;
				}
			},
			schema,
		});
	}
	// const procedures = new Array(...rows).map((procedure) => {
	// 	return {
	// 		name: procedure.name,
	// 		definition: procedure.definition,
	// 		parameters: JSON.parse(procedure.parameters),
	// 	};
	// });

	// const proceduresMap = new Map(
	// 	procedures.map(addProcedureMetadata).reduce((acc, procedure) => {
	// 		acc.push([procedure.name, procedure]);
	// 		return acc;
	// 	}, [] as [string, ReturnType<typeof addProcedureMetadata>][])
	// );

	// console.log(proceduresMap);
	// // for(const procedure of procedures) {

	// app.route({
	// 	method: 'GET',
	// 	url: '/procedures',
	// 	handler: async (request, reply) => {
	// 		const procedures = await app.db.query("SELECT * FROM information_schema.routines WHERE routine_type = 'PROCEDURE'");
	// 		reply.send(procedures);
	// 	},
	// 	schema: {
	// 		querystring: z.object({ test: z.string() }),
	// 		params: {},
	// 		//response: {},
	// 		//test: z.object({ test: z.string() }),
	// 		//body: {},
	// 	},
	// });
}
function parseProcedureName(procedureName: string, prefix: string = 'api_') {
	const nameWithoutPrefix = procedureName.replace(prefix, '');
	const [methodPart, ...urlParts] = nameWithoutPrefix.split('_');
	const method = methodPart.toUpperCase();
	let url = urlParts
		.join('_')
		.replace(/__/g, '/')
		.replace(/\.(\w+)\./g, ':$1');

	return [method, `/${url}`];
}

function generateZodSchema(procedure: Procedure, metadata: Spec[], parser: { parse: (string: string) => z.ZodAny }) {
	const schema = {} as {
		querystring?: z.ZodObject<any>;
		params?: z.ZodObject<any>;
		body?: z.ZodObject<any>;
		headers?: z.ZodObject<any>;
	};

	for (const tag of metadata) {
		if (tag.tag === 'param') {
			const [tagname, name, alias] = tag.name.match(/(\w+)<(\w+)>/) || [tag.name, tag.name, tag.name];

			const schemaPart = parser.parse(tag.description) || z.string();

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
				default:
					throw new Error(`Unknown parameter type: ${tag.type} for parameter: ${tag.name}`);
			}
		}
	}

	return schema;
}

class ZodSchemaParser {
	private context: vm.Context;
	constructor() {
		this.context = this.createRestrictedContext();
	}

	private createRestrictedContext() {
		const sandbox = {
			z: z, // Expose only the 'z' object
		};

		// Remove dangerous globals
		const context = vm.createContext(sandbox, {
			name: 'zod-sandbox',
			origin: 'zod-sandbox',
		});

		// Remove all properties from global
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
		const script = new vm.Script(string);
		const schema = script.runInContext(this.context);

		return schema;
	}
}

function generateGuards(
	procedure: Procedure,
	metadata: Spec[],
	guardMap: {
		[name: string]: (params: string[]) => (request: FastifyRequest, reply: any) => Promise<void>;
	}
) {
	return metadata
		.filter((tag) => tag.tag === 'guard')
		.map((guard) => {
			if (!guardMap[guard.name]) {
				throw new Error(`Guard not found: ${guard.name}`);
			}
			const paraps = guard.description.split(',').map((param) => param.trim());
			const guardFunction = guardMap[guard.name](paraps);

			return guardFunction;
		});
}

function getParamMetadata(metadata: Spec[]) {
	return metadata.reduce(
		(acc, tag) => {
			if (tag.tag === 'param') {
				const [tagname, name, alias] = tag.name.match(/(\w+)<(\w+)>/) || [tag.name, tag.name, tag.name];

				acc[name] = {
					name: name,
					alias: alias,
					getFrom: tag.type,
					description: tag.description,
				};
			}

			return acc;
		},
		{} as {
			[name: string]: {
				name: string;
				alias: string;
				getFrom: string;
				description: string;
			};
		}
	);
}

export default fp(registerProcedureRoutes);
