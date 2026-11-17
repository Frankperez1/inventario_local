# Inventario de Bienes Patrimoniales — UNCP

Aplicación web para inventariar bienes patrimoniales de la **Universidad Nacional del Centro del Perú (Huancayo)**:
escaneo de códigos, registro por *Local › Área › Ambiente*, reportes en PDF/Excel y sincronización en la nube entre varios
equipos. Funciona **sin conexión** y sincroniza cuando vuelve el internet.

## Características

- Registro por escaneo de QR/código de barras, con control de duplicados y bienes en otro ambiente.
- Encargado de cada ambiente tomado automáticamente de `inventario.xlsx`.
- **Reporte de faltantes por ambiente** (ordenado alfabéticamente) con exportación a PDF.
- Actas por área y reportes del equipo técnico.
- **Inicio de sesión** con Firebase Authentication, también **sin conexión** (acceso local con huella PBKDF2).
- **Inventario independiente por usuario**: cada usuario guarda y descarga solo lo que él registró (sincronizado entre sus propios equipos). No ve ni mezcla lo de los demás. Solo se sube lo registrado, no el catálogo de ~105 000 bienes.
- **Avisos**: lo único que se comparte entre usuarios. Si alguien encuentra un bien en un ambiente que no le corresponde, el **grupo dueño** recibe la alerta (el bien no pasa al inventario de nadie más).
- **Mi panel** para cada usuario: su perfil, grupo, avance por área y avisos recientes.
- **Panel de administrador**: crea usuarios, asigna roles y grupos del Excel, y calcula el **avance global** de todos los usuarios cuando lo pide.

## Estructura del proyecto

```
inventario_local/
├── index.html                  Página principal
├── iniciar-servidor.bat        Abre la app en http://localhost:8000
├── firebase-config.js          Credenciales públicas del proyecto Firebase + administradores
├── firestore.rules             Reglas de seguridad de Firestore (pegar en la consola de Firebase)
├── firestore.indexes.json      Índices compuestos que necesita el acceso por grupo
├── css/
│   ├── styles.css              Estilos de la aplicación
│   └── nube.css                Estilos de login, avisos y panel de administración
├── js/
│   ├── app.js                  Lógica principal (inventario, reportes, PDF)
│   ├── escaner.js              Cámara: vigilante, linterna, zoom y lectura inteligente (OCR)
│   └── nube/                   Módulo de nube (ES modules)
│       ├── index.js            Punto de entrada: expone window.Nube
│       ├── estado.js           Estado compartido y constantes
│       ├── utils.js            Claves, firmas y mapas de ubicación
│       ├── sync.js             Subir y bajar bienes registrados
│       ├── perfil.js           Perfil del usuario (rol, grupos, activo) y acceso por grupo
│       ├── acceso.js           Pantalla de inicio de sesión + modo sin conexión
│       ├── avisos.js           Avisos y notificaciones por grupo
│       ├── panel.js            Mi panel: interfaz del usuario
│       ├── admin.js            Panel del administrador
│       └── ui.js               Barra flotante y ventana de cuenta
├── assets/                     Logo institucional
├── data/                       inventario.xlsx y datos-extra.json
└── libs/                       Librerías locales (xlsx, jsPDF, Firebase, html5-qrcode)
```

## Cómo ejecutarlo

1. Instale Python 3 (para el servidor local).
2. Haga doble clic en `iniciar-servidor.bat` y abra <http://localhost:8000>.
3. Use siempre `localhost` (no abra `index.html` directo): los módulos y el cifrado del acceso sin conexión lo requieren.

## Configuración de Firebase (una sola vez)

1. En **Authentication** active *Correo y contraseña*.
2. En **Firestore Database** cree la base de datos y, en *Reglas*, pegue `firestore.rules`
   (ya viene con `admin@gmail.com` como administrador).
3. Cree en **Authentication › Usuarios** la cuenta `admin@gmail.com` con su clave. Ese correo es **siempre administrador**: no hay que hacer nada más.
   (Opcional) para más administradores, en `firebase-config.js` agregue debajo de `window.FIREBASE_CONFIG`:
   ```js
   window.FIREBASE_ADMINS = ["otro-admin@gmail.com"];   // opcional: admin@gmail.com ya es administrador siempre
   ```
4. Inicie sesión con `admin@gmail.com`: aparece el botón **🛡 Admin** para crear usuarios y asignar grupos. Cada usuario ve su **👤 Mi panel**.

## Roles y grupos

| Rol | Puede |
|---|---|
| Administrador | Crear usuarios, asignar grupos, calcular el avance global, recibir todos los avisos |
| Inventariador | Registrar bienes en su propio inventario y recibir avisos de **su grupo** |

Los grupos son los de la columna `GRUPO` de `inventario.xlsx`.

## Cada usuario ve solo su grupo

**Asignar grupos (administrador):** 🛡 Admin › Usuarios › *Asignar grupo a un correo que ya existe en Firebase*. Escriba el correo con el que la persona inicia sesión, marque el grupo (los grupos salen de la columna `GRUPO` del Excel) y pulse *Asignar grupo*. No hace falta crear la cuenta otra vez ni esperar a que entre: el grupo se aplica apenas inicie sesión, y si ya tiene la app abierta se actualiza sola.

**Qué ve cada usuario:** solo los ambientes de sus grupos (selectores Local › Área › Ambiente, buscador, faltantes, actas, encargados, comentarios). Sin grupo ve el aviso *"Aún no tiene un grupo asignado"*. El administrador ve todo. Sin internet usa el último perfil guardado en el equipo.

**Qué descarga cada usuario:** solo sus propios bienes registrados (documentos con su `uid`). Las reglas de Firestore impiden leer o modificar los de otro usuario. Las únicas lecturas compartidas son los **avisos** del grupo dueño del bien.

### Pasos para activarlo (una sola vez)

1. **Reglas:** en Firebase › Firestore › *Reglas*, pegue todo `firestore.rules` y publique.
2. **Índices:** en Firestore › *Índices* › *Compuestos*, cree estos dos (o ejecute `firebase deploy --only firestore:indexes` con `firestore.indexes.json`). Si falta alguno, la app muestra *"Falta crear un índice"* y en la consola del navegador (F12) aparece un enlace que lo crea con un clic:
   - `inventario`: `uid` ↑ + `updatedAt` ↑
   - `avisos`: `grupo` ↑ + `at` ↓
3. **Datos anteriores:** no hay que hacer nada. La primera vez que cada usuario abre la app actualizada, lo que ya tenía registrado en ese equipo se sube a su espacio propio, sin repetir avisos antiguos. Los documentos compartidos de la versión anterior quedan en Firestore sin dueño (solo el administrador puede verlos); puede borrarlos desde la consola cuando todos los usuarios hayan abierto la nueva versión.

### Límites
- El catálogo `data/inventario.xlsx` lo descarga cualquiera que abra la app: la restricción de pantalla es de comodidad, el aislamiento real es el de Firestore (bienes registrados de cada usuario).
- El inventario local vive en el **navegador**: si dos personas usan el mismo navegador del mismo equipo, comparten esa copia local. Cada persona debe usar su propio equipo o su propio perfil de navegador.
- Cualquier usuario activo puede registrar un bien de otro grupo (así se generan los avisos al grupo dueño). El bien queda en el inventario de quien lo encontró.
- Para escribir, el usuario debe tener perfil (creado desde 🛡 Admin) o una asignación por correo; una cuenta que solo existe en Authentication puede iniciar sesión pero no escribe.
- Si agrega administradores en `window.FIREBASE_ADMINS`, agregue los mismos correos en la función `esAdminCorreo()` de `firestore.rules` y vuelva a publicar las reglas.
- El **avance global** del administrador hace una lectura por cada bien registrado (plan gratuito: 50 000 lecturas al día); por eso solo se calcula al pulsar el botón.

## Cámara y lectura inteligente

- La cámara se **libera sola** al salir de la app y se reabre al volver; un vigilante la reinicia si el video se congela.
- Usa resolución alta, enfoque continuo, **linterna** y **zoom** cuando el celular los permite; suena y vibra al leer.
- **Lectura inteligente:** si en ~3 segundos no se lee el código de barras (etiqueta dañada o barras cortadas), la app lee el **número impreso** con OCR (también con el botón **🤖 Leer número**). Prueba el cuadro completo y la mitad inferior de la imagen (el número puede estar bajo las barras) y valida contra el catálogo: si el número coincide exacto, lo registra; si el OCR se equivocó hasta en 2 dígitos y hay un único código parecido en el catálogo, **lo propone para confirmar** (no lo registra solo). La primera vez descarga el motor (Tesseract.js) y necesita internet; para usarlo sin conexión copie Tesseract.js (`tesseract.min.js`, `worker.min.js`, el núcleo `tesseract-core*.wasm.js` y `eng.traineddata.gz`) en `libs/tesseract/`.

## Modo sin conexión

- Con sesión ya iniciada en el equipo, la app entra sola aunque no haya internet.
- Sin sesión y sin internet: se entra con correo y clave si ese equipo ya inició sesión antes, o con *Continuar sin conexión (solo local)*.
- Al volver el internet se suben los cambios pendientes automáticamente.

## Notas

- Si el repositorio es público, no suba `data/inventario.xlsx` ni `data/datos-extra.json` (contienen datos reales). Vea `.gitignore`.
- Las claves de `firebase-config.js` no son secretas; la protección real son las reglas de Firestore.
