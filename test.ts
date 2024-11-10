import mysql from 'mysql2/promise';

async function main() {
	const connection = await mysql.createPool({
		host: 'localhost',
		user: 'root', // Replace with your MySQL username
		password: '', // Replace with your MySQL password
		database: 'test', // Replace with your database name
		multipleStatements: true, // Enable multiple statements
	});

	try {
		const inputUserId = 1;

		// Prepare the SQL statements
		const sql = `
      SET @totalUsers = NULL;
      CALL testout(?, @totalUsers);
      SELECT @totalUsers AS totalUsers;
    `;

		// Execute the statements
		const dbResponse = await connection.query(sql, [inputUserId]);
		const results = dbResponse[0] as any;

		console.log('Results:', dbResponse);
		// Extract the result sets
		const userDetails = results[1]; // Second result set: user details
		const totalUsersResult = results[3]; // Fourth result set: totalUsers

		// Access the totalUsers value
		const totalUsers = totalUsersResult[0].totalUsers;

		console.log('User Details:', userDetails);
		console.log('Total Users:', totalUsers);
	} catch (err) {
		console.error('An error occurred:', err);
	} finally {
		await connection.end();
	}
}

main().catch((err) => {
	console.error('An error occurred:', err);
});
