// ============================================================================
// Configuración de Firebase (nube) - proyecto inventario2025.
// Estas claves no son secretas: los datos los protegen las reglas de Firestore
// (firestore.rules) y los usuarios creados en Authentication.
// Para apagar la nube, cambie todo el bloque por:  window.FIREBASE_CONFIG = null;
// ============================================================================
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBiY9DxFAQO8wrbciYIPeZ3ArXI-vY5OQU",
  authDomain: "inventario2025-2725b.firebaseapp.com",
  projectId: "inventario2025-2725b",
  storageBucket: "inventario2025-2725b.firebasestorage.app",
  messagingSenderId: "1078299317745",
  appId: "1:1078299317745:web:e6ce3047dde07619cd2050"
};

// admin@gmail.com ya es administrador siempre. Si agrega más administradores aquí,
// agregue los MISMOS correos (en minúsculas) en esAdminCorreo() de firestore.rules.
// window.FIREBASE_ADMINS = ["otro-admin@gmail.com"];
