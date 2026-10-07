import Link from "next/link";

export default function NotFound() {
  return (
    <section>
      <h1>Page not found · Página no encontrada</h1>
      <p>
        <Link href="/en">Go to the home page</Link> · <Link href="/es">Ir a la página de inicio</Link>
      </p>
    </section>
  );
}
