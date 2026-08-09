import { InputHTMLAttributes, ReactNode, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  leftIcon?: ReactNode;
  inputClassName?: string;
};

/** Password field with a consistent, accessible reveal/hide control. */
export default function PasswordInput({ leftIcon, inputClassName = '', className = '', ...props }: Props) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={`relative ${className}`}>
      {leftIcon}
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        className={`${inputClassName} pr-11`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded text-rx-gray-medium hover:text-white focus:outline-none focus:ring-1 focus:ring-rx-yellow/50"
        aria-label={visible ? 'Hide password' : 'Show password'}
        title={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}
