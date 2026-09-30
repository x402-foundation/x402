/**
 * Simple Spinner component for loading states
 *
 * @param props - The component props
 * @param props.className - Optional CSS classes to apply to the spinner
 * @returns The Spinner component
 */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center justify-center ${className}`}>
      <div
        className="animate-spin border-2 border-gray-200 border-t-gray-400 rounded-full w-4 h-4"
        style={{
          animation: "spin 1s linear infinite",
          borderTopWidth: "2px",
        }}
      />
    </div>
  );
}
