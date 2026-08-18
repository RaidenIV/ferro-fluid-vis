export default "#version 300 es\n\nin vec2 a_position;\n\nout vec2 v_uv;\n\nvoid main() {\n    v_uv = 0.5 * a_position + 0.5;\n    gl_Position = vec4(a_position, 0., 1.);\n}";
