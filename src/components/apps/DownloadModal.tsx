import { X, Download, Monitor, Smartphone, Laptop } from 'lucide-react';

type Props = {
  app: any;
  onClose: () => void;
  onDownload: (platform: string) => void;
};

const platforms = [
  { id: 'windows', label: 'Windows', ext: 'EXE', icon: Monitor, desc: 'Windows 10/11 • Installer (.exe)' },
  { id: 'linux', label: 'Linux', ext: 'DEB', icon: Laptop, desc: 'Ubuntu/Debian (.deb) • Also AppImage' },
  { id: 'android', label: 'Android', ext: 'APK', icon: Smartphone, desc: 'Android 8+ • APK' },
  { id: 'web', label: 'Web', ext: 'ZIP', icon: Download, desc: 'Web build • ZIP' },
];

export default function DownloadModal({ app, onClose, onDownload }: Props) {
  const available = (app.platforms || ['web']) as string[];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} className="bg-rx-dark-secondary border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-white">Download {app.name}</h3>
            <p className="text-xs text-rx-gray-medium">Choose your platform • v{app.version}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-rx-gray-medium"><X className="w-5 h-5"/></button>
        </div>
        <div className="p-4 space-y-3">
          {platforms.filter(p=> available.includes(p.id)).map(p => (
            <button key={p.id} onClick={()=>onDownload(p.id)} className="w-full flex items-center gap-4 p-4 rounded-xl bg-rx-dark hover:bg-rx-dark-tertiary border border-white/10 hover:border-rx-yellow/30 transition-all text-left group">
              <div className="w-12 h-12 rounded-xl bg-rx-yellow/10 flex items-center justify-center group-hover:bg-rx-yellow/20"><p.icon className="w-6 h-6 text-rx-yellow"/></div>
              <div className="flex-1">
                <p className="font-semibold text-white flex items-center gap-2">{p.label} <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-rx-gray-medium">{p.ext}</span></p>
                <p className="text-xs text-rx-gray-medium">{p.desc}</p>
              </div>
              <Download className="w-5 h-5 text-rx-gray-medium group-hover:text-rx-yellow"/>
            </button>
          ))}
          {available.length===0 && <p className="text-sm text-rx-gray-medium text-center py-4">No downloads available for this app yet.</p>}
        </div>
        <div className="p-3 bg-rx-dark/50 border-t border-white/5 text-xs text-rx-gray-medium text-center">Downloads count only when you confirm — each successful download +1</div>
      </div>
    </div>
  );
}
