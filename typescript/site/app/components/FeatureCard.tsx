import Image from "next/image";

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

export function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="w-12 h-12 flex items-center justify-center" aria-hidden="true">
        {icon}
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-2xl font-medium">{title}</h3>
        <p className="text-base text-black">{description}</p>
      </div>
    </div>
  );
}

export function ZeroFeesIcon() {
  return (
    <Image
      src="/images/icons/dollar_group11.svg"
      alt=""
      width={27}
      height={46}
      aria-hidden="true"
    />
  );
}

export function ZeroWaitIcon() {
  return (
    <Image
      src="/images/icons/clock_group10.svg"
      alt=""
      width={46}
      height={46}
      aria-hidden="true"
    />
  );
}

export function ZeroFrictionIcon() {
  return (
    <Image
      src="/images/icons/paper_group26.svg"
      alt=""
      width={40}
      height={54}
      aria-hidden="true"
    />
  );
}

export function ZeroCentralizationIcon() {
  return (
    <Image
      src="/images/icons/dots_group24.svg"
      alt=""
      width={53}
      height={50}
      aria-hidden="true"
    />
  );
}

export function ZeroRestrictionsIcon() {
  return (
    <Image
      src="/images/icons/union_group20.svg"
      alt=""
      width={45}
      height={51}
      aria-hidden="true"
    />
  );
}