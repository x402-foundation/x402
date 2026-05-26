interface ComparisonStep {
  number: string;
  title: string;
  description: string;
}

interface ComparisonTableProps {
  traditionalSteps: ComparisonStep[];
  x402Steps: ComparisonStep[];
}

interface ScenarioComparison {
  title: string;
  traditional: string[];
  x402: string[];
}

interface ScenarioComparisonTableProps {
  scenarios: ScenarioComparison[];
  className?: string;
}

export function ComparisonTable({
  traditionalSteps,
  x402Steps,
}: ComparisonTableProps) {
  return (
    <div className="w-full">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-10">
        {/* Traditional Process Column */}
        <div className="flex flex-col gap-8">
          <h3 className="text-sm sm:text-base font-bold text-gray-40 uppercase tracking-wide">
            The old way
          </h3>

          <div className="flex flex-col gap-8">
            {traditionalSteps.map((step, index) => (
              <div key={index} className="flex gap-3 sm:gap-4">
                <div className="w-[34px] h-[34px] flex-shrink-0 flex items-center justify-center border border-black">
                  <span className="text-lg font-medium">{step.number}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <h4 className="text-sm sm:text-base font-medium">{step.title}</h4>
                  <p className="text-sm sm:text-base font-mono text-gray-60 leading-snug">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* x402 Process Column */}
        <div className="flex flex-col gap-8">
          <h3 className="text-sm sm:text-base font-bold text-green-60 uppercase tracking-wide">
            With x402
          </h3>

          <div className="flex flex-col gap-8">
            {x402Steps.map((step, index) => (
              <div key={index} className="flex gap-3 sm:gap-4">
                <div className="w-[34px] h-[34px] flex-shrink-0 flex items-center justify-center border border-accent-green bg-accent-green">
                  <span className="text-lg font-medium text-white">
                    {step.number}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <h4 className="text-sm sm:text-base font-medium text-accent-green">
                    {step.title}
                  </h4>
                  <p className="text-sm sm:text-base font-mono text-green-60 leading-snug">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ScenarioComparisonTable({
  scenarios,
  className = "",
}: ScenarioComparisonTableProps) {
  return (
    <div
      className={`w-full overflow-hidden border border-gray-10 rounded-lg ${className}`}
    >
      <div className="grid grid-cols-1 md:grid-cols-3 bg-gray-10 text-xs sm:text-sm font-semibold uppercase tracking-wide text-gray-70">
        <div className="px-5 py-4">Scenario</div>
        <div className="px-5 py-4">Traditional process</div>
        <div className="px-5 py-4">With x402</div>
      </div>

      <div className="divide-y divide-gray-10">
        {scenarios.map((scenario) => (
          <div key={scenario.title} className="grid grid-cols-1 md:grid-cols-3">
            <div className="px-4 sm:px-5 py-4 sm:py-6 text-sm sm:text-base font-semibold leading-snug">
              {scenario.title}
            </div>
            <div className="px-4 sm:px-5 py-4 sm:py-6">
              <ul className="list-disc pl-4 space-y-1.5 sm:space-y-2 text-xs sm:text-sm text-gray-70">
                {scenario.traditional.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="px-4 sm:px-5 py-4 sm:py-6">
              <ul className="list-disc pl-4 space-y-1.5 sm:space-y-2 text-xs sm:text-sm text-accent-green">
                {scenario.x402.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}