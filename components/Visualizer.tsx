import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
  isModel?: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ analyser, isActive, isModel = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !analyser) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const baseRadius = 70;
      
      // Calculate average volume for pulse
      const average = dataArray.reduce((a, b) => a + b) / bufferLength;
      const pulseFactor = isActive ? (average / 128) * 30 : 0;
      const radius = baseRadius + pulseFactor;

      // Glow color based on role
      const color = isModel ? '#818cf8' : '#6366f1';
      
      // Draw outer soft rings
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius + 10, 0, Math.PI * 2);
      ctx.strokeStyle = `${color}11`;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw frequency rays
      const rays = 72;
      for (let i = 0; i < rays; i++) {
        const index = Math.floor((i / rays) * (bufferLength / 2));
        const amplitude = isActive ? (dataArray[index] / 255) * 60 : 2;
        const angle = (i / rays) * Math.PI * 2;
        
        const x1 = centerX + Math.cos(angle) * (radius - 5);
        const y1 = centerY + Math.sin(angle) * (radius - 5);
        const x2 = centerX + Math.cos(angle) * (radius + amplitude);
        const y2 = centerY + Math.sin(angle) * (radius + amplitude);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `${color}${isActive ? 'cc' : '44'}`;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Center "Core"
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius - 10, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? `${color}11` : 'transparent';
      ctx.fill();
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [analyser, isActive, isModel]);

  return (
    <div className="relative flex items-center justify-center">
      <div className={`absolute w-32 h-32 rounded-full transition-all duration-1000 ${isActive ? 'orb-glow bg-indigo-500/10' : 'bg-slate-800/5'}`} />
      <canvas 
        ref={canvasRef} 
        width={350} 
        height={350} 
        className="z-10"
      />
    </div>
  );
};

export default Visualizer;