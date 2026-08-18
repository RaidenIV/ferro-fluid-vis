export default "#version 300 es\n\nin vec2 a_position;\n\nvoid main() {\n    gl_Position = vec4(a_position, 0., 1.);\n}";
