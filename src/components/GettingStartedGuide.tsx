import React, { useState } from 'react';

interface Step {
  id: number;
  title: string;
  description: string;
  completed: boolean;
}

export const GettingStartedGuide: React.FC = () => {
  const [steps, setSteps] = useState<Step[]>([
    {
      id: 1,
      title: 'Connect Your Wallet',
      description: 'Connect your Solana wallet to start sniping tokens',
      completed: false,
    },
    {
      id: 2,
      title: 'Configure RPC Settings',
      description: 'Set up your Helius API key for optimal performance',
      completed: true,
    },
    {
      id: 3,
      title: 'Create Your First Snipe Config',
      description: 'Set up your first token sniping configuration',
      completed: false,
    },
    {
      id: 4,
      title: 'Monitor New Tokens',
      description: 'Start monitoring for new token launches',
      completed: false,
    },
  ]);

  const toggleStep = (id: number) => {
    setSteps(prev =>
      prev.map(step =>
        step.id === id ? { ...step, completed: !step.completed } : step
      )
    );
  };

  const completedSteps = steps.filter(step => step.completed).length;
  const progressPercentage = (completedSteps / steps.length) * 100;

  return (
    <div className="bg-gradient-to-br from-gray-800/50 to-gray-900/50 backdrop-blur-sm border border-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-white">Getting Started</h2>
        <div className="text-sm text-muted-foreground">
          {completedSteps}/{steps.length} completed
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-muted-foreground">Progress</span>
          <span className="text-sm text-sky-400">{Math.round(progressPercentage)}%</span>
        </div>
        <div className="w-full bg-secondary rounded-full h-2">
          <div
            className="bg-gradient-to-r from-sky-500 to-blue-500 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progressPercentage}%` }}
          />
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-4">
        {steps.map((step) => (
          <div
            key={step.id}
            className={`flex items-start space-x-3 p-3 rounded-lg border cursor-pointer transition-all duration-200 ${
              step.completed
                ? 'bg-green-900/20 border-green-500/30 hover:bg-green-900/30'
                : 'bg-secondary/30 border-input hover:bg-secondary/50'
            }`}
            onClick={() => toggleStep(step.id)}
          >
            <div className="flex-shrink-0 mt-0.5">
              {step.completed ? (
                <div className="w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
              ) : (
                <div className="w-5 h-5 border-2 border-gray-500 rounded-full" />
              )}
            </div>
            <div className="flex-1">
              <h3 className={`font-medium ${step.completed ? 'text-green-400' : 'text-white'}`}>
                {step.title}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">{step.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="mt-6 pt-6 border-t border-border">
        <h3 className="text-sm font-medium text-foreground/80 mb-3">Quick Actions</h3>
        <div className="grid grid-cols-2 gap-3">
          <button className="bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/30 text-sky-400 px-3 py-2 rounded-lg text-sm transition-colors">
            📚 View Docs
          </button>
          <button className="bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-400 px-3 py-2 rounded-lg text-sm transition-colors">
            💬 Get Support
          </button>
        </div>
      </div>
    </div>
  );
};
