import mysql from 'npm:mysql2/promise';
import { parse, Block, Spec } from 'npm:comment-parser';
import config from './config.ts';
import { z } from 'zod';
import vm from 'node:vm';

const connection = mysql.createPool(config.database);

interface Procedure {
	ROUTINE_NAME: string;
	ROUTINE_TYPE: string;
	ROUTINE_DEFINITION: string;
}

async function getProcedures() {
	const procedures = await connection
		.query(
			/*sql*/ `
		SELECT 
			ROUTINE_NAME,
			ROUTINE_TYPE,
			ROUTINE_DEFINITION
		FROM information_schema.ROUTINES 
		WHERE ROUTINE_SCHEMA = '${config.database.database}' 
			AND ROUTINE_TYPE = 'PROCEDURE'
			AND ROUTINE_NAME LIKE '${config.procedurePrefix}_%_%'
	`
		)
		.then((result) => result[0] as Procedure[]);

	return procedures;
}

function getProcedureMetadata(procedure: Procedure) {
	const parsedDefinition = parse(procedure.ROUTINE_DEFINITION);
	//Deno.writeTextFile('parsedDefinition.json', JSON.stringify(parsedDefinition, null, 2));
	const validationMetadata = parsedDefinition.filter((block) => block.tags.some((tag) => tag.tag === 'validation'));
	return validationMetadata;
}

const procedures = await getProcedures();

const metadata = getProcedureMetadata(procedures[3]);
const validations = generateZodSchemaFromMetadata(metadata[0].tags);

function createRestrictedContext() {
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
function generateZodSchemaFromMetadata(tags: Spec[], type: 'object' | 'array' = 'object'): z.ZodObject<any> | z.ZodArray<any> {
	const context = createRestrictedContext();

	const optionalParams = tags.filter((tag: any) => tag.tag === 'optional').map((tag: any) => tag.name);

	const shape = tags.reduce((acc, param) => {
		const paramName = param.name;

		try {
			// Build the Zod schema code
			const code = buildSchemaCode(param);

			// Prepare the script
			const script = new vm.Script(code);

			// Run the script in the context
			const zodSchema: z.ZodTypeAny = script.runInContext(context);

			acc[paramName] = zodSchema;
			return acc;
		} catch (error: any) {
			throw new Error(`{ processing parameter '${paramName}': ${error.message} }`);
		}
	}, {} as any);

	return z.object(shape);
}

function buildSchemaCode(tag: Spec): string {
	let code = `z.${tag.type}()`;
	if (tag.description) {
		code += tag.description.trim();
	}

	return code;
}
