CREATE TABLE clientes (
  id INT PRIMARY KEY,
  nombre TEXT,
  email TEXT,
  telefono TEXT,
  tarjeta TEXT
);
INSERT INTO clientes VALUES
  (1, 'Ana Perez', 'ana.perez@example.com', '+34 600 111 222', '4111 1111 1111 1111'),
  (2, 'Luis Gomez', 'luis.gomez@example.com', '+34 600 333 444', '5500 0000 0000 0004'),
  (3, 'Marta Ruiz', 'marta.ruiz@example.com', '+34 611 555 666', '3400 000000 00000');
CREATE TABLE notas (
  id INT PRIMARY KEY,
  nota TEXT
);
INSERT INTO notas VALUES (1, 'sin datos personales'), (2, 'tampoco hay aqui');
CREATE SCHEMA IF NOT EXISTS otros;
CREATE TABLE otros.ajeno (
  id INT PRIMARY KEY,
  email TEXT
);
INSERT INTO otros.ajeno VALUES (1, 'ajeno@example.com');
CREATE TABLE "we""ird" (
  id INT PRIMARY KEY,
  email TEXT
);
INSERT INTO "we""ird" VALUES (1, 'hostil@example.com');
