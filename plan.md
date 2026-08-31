Actúa como un Ingeniero de Software Frontend experto en gráficos 3D (Three.js) y Visión por Computador. Necesito que construyas el código fuente estructurado para una aplicación web interactiva de dibujo y anatomía artística. 

La aplicación debe capturar el esqueleto del usuario mediante la cámara web local o cargar imagenes, procesarlo en tiempo real a 60fps usando MediaPipe/BlazePose, y transferir ese movimiento como una marioneta virtual a un modelo 3D dinámico que contiene múltiples mallas anatómicas intercambiables.

quiero tener un entorno 3d bonito y profesional donde pueda crear camara y poder controlar distintos valores de la camara apertura fov etc esto para que puedo colocar en el plano que quiera y con la distorcion de lente que neceite entiendes 

Requisitos de la Arquitectura y Código a Generar:

1. Stack Tecnológico Obligatorio:
   - HTML5, CSS moderno (puedes usar Tailwind si se requiere) y JavaScript puro (ES6 módulos).
   - Three.js (versión reciente) para el renderizado de la escena 3D, luces y cámaras.
   - Scripts oficiales CDN de Google MediaPipe (Pose Landmarker / BlazePose) para inferencia local en el navegador del cliente.
   - Kalidokit (CDN) para calcular las rotaciones (Quaternions) de los huesos a partir de los puntos X,Y,Z de MediaPipe.

2. Escena 3D y Sistema de Cámaras:
   - Configura un lienzo de Three.js que ocupe toda la pantalla.
   - Añade una cámara de perspectiva interactiva controlada por OrbitControls para que el estudiante pueda rotar y hacer zoom sobre el modelo.
   - Crea un interruptor en la UI para cambiar la cámara a modo "Ortográfico" (sin distorsión de perspectiva) para estudios de proporción anatómica lineal.
   - Configura un sistema de iluminación de estudio: Una luz ambiental suave y una Luz Direccional (DirectionalLight) potente que proyecte sombras. Haz que la posición de esta luz sea controlable mediante sliders (X, Y, Z) en la interfaz para simular ejercicios de claroscuro (luces y sombras).

3. Sistema de Carga e Intercambio de Mallas (Multi-Mesh / Shared Rigging):
   - Escribe la lógica para cargar un único archivo de personaje `.glb` estructurado con el esqueleto estándar de Mixamo ("mixamorig...").
   - El modelo contendrá tres mallas de geometría separadas que comparten el mismo esqueleto: "Mesh_Anatomica" (Músculos), "Mesh_Maniqui" (Cajas/Madera), y "Mesh_Esqueleto" (Huesos).
   - Implementa una función reactiva 'cambiarGeometria(tipo)' vinculada a botones en la interfaz de usuario. Al hacer clic, debe alternar la propiedad '.visible = true/false' de las respectivas mallas para que los estudiantes cambien de visualización instantáneamente manteniendo la pose actual.
   - Añade un slider de opacidad general que altere el '.opacity' y active '.transparent = true' en el material de la malla activa, permitiendo ver el esqueleto interno traslucido bajo la musculatura.

4. Captura del Movimiento (La Marioneta):
   - Configura el acceso a la cámara web (`navigator.mediaDevices.getUserMedia`) y envíala en bucle al detector de pose de MediaPipe.
   - Captura el output de los 33 puntos clave (Landmarks 3D).
   - Pasa estos puntos a Kalidokit para obtener los ángulos e interpolaciones.
   - Mapea esas rotaciones generadas por Kalidokit directamente a los huesos correspondientes cargados en la escena de Three.js (ej. mapear los brazos a "mixamorigLeftArm", "mixamorigRightArm", hombros, cadera y piernas). Aplica interpolación suave tipo .slerp() en cada frame de animación para evitar que la geometría 3D vibre o tiemble (jittering).

Entrega el código bien comentado, estructurado de forma modular (separando la lógica del renderizador 3D, el procesador de IA de MediaPipe, y los controladores de la interfaz), y optimizado para ejecutarse localmente sin depender de servidores o backends dedicados.

has que todo sea muyu profesional con un entorno modo oscuro como la iamgen que te proporcionare que es el team de visual estudio code, y con iconos de lucide para que se mantenga la unidad grafica
