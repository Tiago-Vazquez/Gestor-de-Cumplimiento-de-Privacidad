CREATE TABLE clientes (
  id INT PRIMARY KEY,
  nombre VARCHAR(120),
  email VARCHAR(200),
  telefono VARCHAR(40),
  tarjeta VARCHAR(30)
);
INSERT INTO clientes VALUES
  (1, 'Ana Perez', 'ana.perez@example.com', '+34 600 111 222', '4111 1111 1111 1111'),
  (2, 'Luis Gomez', 'luis.gomez@example.com', '+34 600 333 444', '5500 0000 0000 0004'),
  (3, 'Marta Ruiz', 'marta.ruiz@example.com', '+34 611 555 666', '3400 000000 00000');
CREATE TABLE notas (
  id INT PRIMARY KEY,
  nota VARCHAR(200)
);
INSERT INTO notas VALUES (1, 'sin datos personales'), (2, 'tampoco hay aqui');
CREATE TABLE `weird``name` (
  id INT PRIMARY KEY,
  email VARCHAR(200)
);
INSERT INTO `weird``name` VALUES (1, 'hostil@example.com'), (2, 'otro.hostil@example.com');
CREATE DATABASE IF NOT EXISTS m23other;
CREATE TABLE m23other.ajeno (
  id INT PRIMARY KEY,
  email VARCHAR(200)
);
INSERT INTO m23other.ajeno VALUES (1, 'ajeno@example.com');
