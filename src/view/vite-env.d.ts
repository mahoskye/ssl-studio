// Vite's `?worker` and `.css` imports (vite/client's types clash with bun-types).
declare module "*?worker" {
	const WorkerFactory: { new (): Worker };
	export default WorkerFactory;
}

declare module "*.css";
