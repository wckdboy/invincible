/** Stylesheets the bundler takes as text (`with { type: "text" }`), as the terminal does with its own and xterm.js's. */
declare module "*.css" {
  const text: string;
  export default text;
}
