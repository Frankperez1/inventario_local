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
├── firestore.rules             Reglas de seguridad de Firestore
├── firestore.indexes.json      Índices compuestos de Firestore
├── firebase.json / .firebaserc Despliegue con Firebase CLI (opcional)
├── firestore.indexes.json      Índices compuestos que necesita el acceso por grupo
├── css/
│   ├── styles.css              Estilos base de la aplicación
│   ├── tema-uncp.css           Tema institucional claro (verde y oro del escudo UNCP); se carga al final
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

0. **Una sola vez**, con internet: ejecute `descargar-libs.bat` (baja a `libs/` las librerías para trabajar sin conexión) y luego suba `libs/` a Git.

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


## Publicar reglas e índices de Firestore

Hay dos formas; haga **una**:

**A) Desde la consola (sin instalar nada)**
1. Firebase Console › Firestore Database › **Reglas** › pegue el contenido de `firestore.rules` › **Publicar**.
2. Firestore Database › **Índices** › **Compuestos** › cree estos dos (colección, campos):
   - `inventario`: `uid` ascendente + `updatedAt` ascendente
   - `avisos`: `grupo` ascendente + `at` descendente
   (Si falta alguno, la consola del navegador (F12) muestra un enlace que lo crea con un clic.)

**B) Con Firebase CLI**
```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore
```
Usa `firebase.json`, `.firebaserc`, `firestore.rules` y `firestore.indexes.json` de este repositorio.

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


## Modo local automático y subida al volver el internet

- **Sin internet y sin sesión**: la app entra sola en *Modo local* (no pide iniciar sesión). Los bienes registrados se guardan en este equipo.
- **Con sesión iniciada**: si se cae el internet, se sigue trabajando; al volver, los cambios se suben solos a **la cuenta de ese usuario** (cada usuario tiene su propio inventario en la nube) y aparece la notificación *«Datos subidos»*.
- **Con internet pero sin sesión** (modo local): aparece una advertencia *«Necesita iniciar sesión para guardarlos en la nube y no perder sus datos»* con el botón **Iniciar sesión**. Al iniciar, lo registrado en local se sube a la cuenta que inicie sesión.
- Si el usuario cierra sesión a propósito, se muestra el login aunque no haya internet.
- Recuerde: el modo local depende del navegador; si se borran los datos del navegador antes de subir, se pierden. Por eso se insiste en iniciar sesión.

## Nombre del inventariador automático

- Si la persona **inició sesión**, el nombre del inventariador sale de su cuenta (el que le puso el administrador); **no se le vuelve a pedir** al pulsar *Iniciar inventario*, y aparece solo como primer inventariador en las *Actas de verificación*. Funciona también sin conexión (se usa el último perfil guardado en el equipo).
- El botón *Cambiar* pasa a ser *Agregar compañero* (hasta 3 inventariadores por acta) y *Cerrar* se oculta: cerrar sesión es el cierre.
- Si entra otra cuenta en el mismo equipo, el nombre y el equipo del acta cambian solos.
- Si no hay sesión (modo local puro) o el administrador no le puso un nombre válido, se pide a mano como antes.

## DNI y cambio de clave

- Al **crear un usuario** (🛡 Admin → Usuarios) el **DNI es obligatorio** (8 dígitos, no puede repetirse). Queda guardado en su perfil; en la tabla de usuarios se puede completar o corregir y pulsar *Guardar*.
- El DNI del inventariador sale **solo en el acta de verificación**, junto a su nombre.
- **🔑 Cambiar clave (admin)**: envía al correo del usuario el enlace de Firebase para crear una clave nueva. Firebase no permite que el administrador escriba la clave de otra persona desde la app sin un servidor (Cloud Functions, que exige el plan de pago); por eso se usa el enlace. Solo llega si el correo es real.
- **Cambiar mi clave (cada usuario)**: botón en ☁ (estado de la nube). Pide la clave actual y la nueva, y actualiza también el acceso sin conexión de ese equipo.

## Editar usuario (administrador)

- En 🛡 Admin → Usuarios, la tabla es de lectura y cada fila tiene **✏ Editar**: cambia nombre, DNI, rol, grupos y si está activo, y desde ahí se envía el enlace de **🔑 Cambiar clave**.
- El correo no se edita (es el de inicio de sesión en Firebase; para cambiarlo hay que crear otra cuenta).
- Si el administrador cambia el nombre de alguien, su inventariador y su equipo de acta se actualizan solos en la siguiente conexión.

## Cambiar la clave de un usuario (administrador)

- En ✏ Editar → **🔑 Cambiar clave**: se escribe la nueva clave y se aplica **directo, sin correo** (sirve con correos de prueba). Después se le entrega la clave a la persona.
- Cómo funciona sin servidor: la app guarda la clave actual de cada usuario en la colección `claves_admin` (la escribe el propio usuario al crear la cuenta, al iniciar sesión o al cambiarla, y **solo la lee el administrador**); con ella el administrador entra un instante a esa cuenta y le pone la nueva.
- **Hay que volver a publicar `firestore.rules`** (se agregó la regla de `claves_admin`).
- Un usuario antiguo queda listo en cuanto inicia sesión una vez con internet. Si no hay clave guardada, la app pide la clave actual a mano.
- ⚠ Seguridad: las claves quedan visibles para los administradores. Para un proyecto interno con correos de prueba es aceptable, pero **no use claves que la persona use en otros sitios**. Con el plan de pago de Firebase (Cloud Functions) se puede cambiar la clave sin guardarla.
- Si la clave cambia por otra vía (p. ej. un correo real de restablecimiento) la guardada deja de coincidir: la app pide la actual a mano. Último recurso: eliminar la cuenta en la consola de Firebase y crearla de nuevo desde el panel (esa persona empezará con un inventario en la nube vacío).

## Lectura inteligente: solo números de 12 dígitos de la base de datos

- El OCR lee **únicamente** números de 12 dígitos (con o sin guion 8-4) y **solo registra si ese código existe en la base de datos**. Se quitaron las sugerencias de "código parecido".
- Para evitar que un dígito mal leído caiga en otro código que sí existe, el mismo número tiene que leerse **dos veces seguidas** antes de registrarse (toma 1-3 segundos con la cámara firme).
- Si lee 12 dígitos que no están en la base, no registra nada: solo avisa "Leyó XXXXXXXX-XXXX: no figura en la base de datos".
- `descargar-libs.bat` / `.sh` ahora también baja Tesseract a `libs/tesseract/`, así funciona **sin internet**. Ejecútelo una vez con internet.

## Subir a Git / GitHub

1. **Antes de subir** decida si el repositorio será **privado** o **público**. `data/inventario.xlsx` y `data/datos-extra.json` tienen ~900 nombres de responsables: por eso `.gitignore` los excluye. En un repositorio **privado** puede borrar esas dos líneas de `.gitignore` para que se suban; en uno público déjelas.
2. Comandos (una sola vez):
   ```
   git init -b main
   git add .
   git status            # revise que NO aparezcan data/*.xlsx ni libs/ si el repositorio es público
   git commit -m "Inventario UNCP: modo local, nube, actas, lectura por IA"
   git remote add origin https://github.com/USUARIO/NOMBRE-REPO.git
   git push -u origin main
   ```
3. **Después de clonar** en otra PC: copie `data/inventario.xlsx` y `data/datos-extra.json`, ejecute `descargar-libs.bat` (una vez, con internet) e `iniciar-servidor.bat`.
4. **GitHub Pages** (opcional, da https, que la cámara necesita): Settings → Pages → rama `main`, carpeta `/ (root)`. Para que funcione con datos reales el repositorio debe incluir `data/` (privado) y, en Firebase → Authentication → Settings → *Authorized domains*, agregue `USUARIO.github.io`; si no, el inicio de sesión falla.
5. **Reglas de Firestore**: publique `firestore.rules` (consola de Firebase → Firestore → Reglas, o `firebase deploy --only firestore:rules`).
6. La `apiKey` de `firebase-config.js` no es secreta (la protegen las reglas), pero si el repositorio es público conviene restringirla por dominio en Google Cloud → APIs y servicios → Credenciales. **Nunca** suba archivos `serviceAccount*.json` ni `.env` (ya están en `.gitignore`).

## Icono de la pestaña (favicon)

- Se usa el logo de la UNCP: `favicon.ico`, `assets/favicon-64.png`, `assets/favicon-192.png` y `assets/apple-touch-icon.png` (ícono al "agregar a la pantalla de inicio" en iPhone).
- Para cambiarlo, reemplace esos archivos por su imagen (PNG cuadrado, ideal 192×192 o más) con los **mismos nombres**, y suba `?v=2` en los `<link rel="icon">` de `index.html` si el navegador sigue mostrando el anterior (los navegadores guardan el ícono en caché; pruebe también Ctrl+F5).

## Si la nube se queda en "Sincronizando…"

- Pulse el botón azul ☁: abajo dice cuántos cambios "por subir" hay. A los 20 s sin respuesta el botón pasa a **rojo** con la explicación.
- Causa frecuente: el **bloqueador del navegador** (Brave Shields, uBlock, AdGuard) bloquea `firestore.googleapis.com`. Desactive el escudo para el sitio (ícono del león → "Escudos desactivados") y recargue. Otra causa: una red con firewall (la app ya reintenta con *long polling*).
- Compruebe también que publicó `firestore.rules` y que `usuario.github.io` está en Authentication → Authorized domains.
