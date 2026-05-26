export function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="max-w-6xl mx-auto px-4 pb-20 lg:px-12">
      <div>{children}</div>
    </section>
  );
}
