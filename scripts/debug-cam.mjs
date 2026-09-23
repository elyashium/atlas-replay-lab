// Replicates experience/viewer math to check NDC fit.
function lookAt(eye, center) {
  const z = norm3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = norm3(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function multiply(a, b) {
  const c = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++)
    c[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
  return c;
}
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function norm3(v) { const l = Math.hypot(...v) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }

const min = [-1, 0, -1], max = [1, 1.5, 1];
const center = [0, 0.75, 0];
const radius = 1.0;
// portrait canvas like the xr run (backing px)
const W = 1179, H = 2556;
const aspect = W / H;
const halfV = (35 * Math.PI) / 360;
const halfH = Math.atan(Math.tan(halfV) * aspect);
const dist = (radius / Math.sin(Math.min(halfV, halfH))) * 1.2;
const yaw = 0.6, pitch = 0.35;
const eye = [center[0] + dist*Math.cos(pitch)*Math.sin(yaw), center[1] + dist*Math.sin(pitch), center[2] + dist*Math.cos(pitch)*Math.cos(yaw)];
const mvp = multiply(perspective(35, aspect, dist/100, dist*10), lookAt(eye, center));
const verts = [[-1,0,-1],[1,0,-1],[1,0,1],[-1,0,-1],[1,0,1],[-1,0,1],[0,1.5,0]];
let maxAbsX = 0, maxAbsY = 0;
for (const v of verts) {
  const c = [0,0,0,0];
  for (let row = 0; row < 4; row++) c[row] = mvp[row]*v[0] + mvp[4+row]*v[1] + mvp[8+row]*v[2] + mvp[12+row]*1;
  const nx = c[0]/c[3], ny = c[1]/c[3];
  maxAbsX = Math.max(maxAbsX, Math.abs(nx)); maxAbsY = Math.max(maxAbsY, Math.abs(ny));
  console.log(v.map(n=>n.toFixed(2)).join(","), "-> ndc", nx.toFixed(3), ny.toFixed(3));
}
console.log("dist:", dist.toFixed(2), "max|ndc.x|:", maxAbsX.toFixed(3), "max|ndc.y|:", maxAbsY.toFixed(3));
