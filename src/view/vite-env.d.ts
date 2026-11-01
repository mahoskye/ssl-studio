// Vite's `?worker` imports (vite/client's types clash with bun-types).
declare module "*?worker" {
	const WorkerFactory: { new (): Worker };
	export default WorkerFactory;
}
