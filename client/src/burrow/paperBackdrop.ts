import { ShaderMount, ditheringFragmentShader, meshGradientFragmentShader, DitheringShapes, DitheringTypes, type ShaderMountUniforms } from "@paper-design/shaders";

// Loaded only after choosing a Paper look. No remote textures, fonts or scripts.
export function mountPaperBackdrop(element: HTMLElement, mesh: boolean) {
  const sizing = { u_fit: 2, u_scale: 1, u_rotation: 0, u_offsetX: 0, u_offsetY: 0, u_originX: .5, u_originY: .5, u_worldWidth: 0, u_worldHeight: 0 };
  const uniforms: ShaderMountUniforms = mesh ? {
    ...sizing,
    u_colors: [[.12, .8, .7, 1], [.5, .25, .9, 1], [.95, .45, .4, 1], [.12, .3, .65, 1]],
    u_colorsCount: 4, u_distortion: .8, u_swirl: .55, u_grainMixer: .15, u_grainOverlay: .1,
  } : {
    ...sizing,
    u_colorBack: [0, 0, 0, 0], u_colorFront: [.6, .5, 1, 1],
    u_shape: DitheringShapes.swirl, u_type: DitheringTypes["4x4"], u_pxSize: 3,
  };
  return new ShaderMount(element, mesh ? meshGradientFragmentShader : ditheringFragmentShader, uniforms, { alpha: true }, 0, 8000, 1, 500_000);
}
