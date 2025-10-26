🌍 Country API — Express + MySQL

A simple RESTful API built with Express.js and MySQL.
It allows users to perform CRUD operations on a countries database — including adding, fetching, updating, deleting, and querying countries.

🚀 Features

Fetch all countries

Fetch a single country by ID

Create a new country

Update an existing country

Delete a country

Query countries by name or region

🧠 Tech Stack

Node.js

Express.js

MySQL (MySQL Workbench / CLI)

dotenv (for environment variables)

mysql2/promise (for async DB connections)

Postman or cURL for API testing

⚙️ Installation

Clone the repository

git clone https://github.com/hamzadlb/be_stage_two.git
cd be_stage_two


Install dependencies

npm install


Set up the database

Open MySQL Workbench

Run this SQL script:

CREATE DATABASE country_api;
USE country_api;

CREATE TABLE countries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  capital VARCHAR(255),
  region VARCHAR(255),
  population INT
);


Create a .env file

PORT=8000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=country_api


Run the server

npm run dev


or

node server.js


Server will start on http://localhost:8000

📡 API Endpoints
Method	Endpoint	Description
GET	/countries	Get all countries
GET	/countries/:id	Get a specific country by ID
GET	/countries/search?name=...&region=...	Query countries by name or region
POST	/countries	Add a new country
PUT	/countries/:id	Update a country
DELETE	/countries/:id	Delete a country
🧾 Example Requests

1. Add a country

POST /countries
Content-Type: application/json

{
  "name": "Nigeria",
  "capital": "Abuja",
  "region": "Africa",
  "population": 206000000
}


2. Query countries

GET /countries/search?region=Africa


3. Update a country

PUT /countries/1
Content-Type: application/json

{
  "capital": "Lagos"
}


4. Delete a country

DELETE /countries/1

🧰 Useful Commands
Command	Description
npm start	Run the server normally
npm run dev	Run server with hot reload (using nodemon)
mysql -u root -p	Connect to MySQL CLI
SHOW DATABASES;	List all databases
💡 Notes

Use Postman to test your endpoints.

If you get an access denied error, check your MySQL username/password and ensure the DB_USER has privileges on the database.

If the server fails to connect, ensure MySQL Server is running.
