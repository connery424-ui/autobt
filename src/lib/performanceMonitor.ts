/**
 * Performance monitoring utilities for SolSniper
 * Helps track and optimize slow operations
 */

interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  details?: any;
}

class PerformanceMonitor {
  private static metrics: PerformanceMetric[] = [];
  private static readonly MAX_METRICS = 1000; // Keep last 1000 metrics
  
  /**
   * Start timing an operation
   */
  static startTimer(operation: string): (details?: any) => number {
    const start = Date.now();
    
    return (details?: any): number => {
      const duration = Date.now() - start;
      this.recordMetric(operation, duration, details);
      
      // Log slow operations
      if (duration > 1000) { // > 1 second
        console.warn(`⚠️ SLOW OPERATION: ${operation} took ${duration}ms`, details);
      } else if (duration > 500) { // > 500ms
        console.log(`🐌 ${operation} took ${duration}ms`, details);
      } else if (duration > 100) { // > 100ms
        console.log(`⏱️ ${operation} took ${duration}ms`);
      }
      
      return duration;
    };
  }
  
  /**
   * Record a performance metric
   */
  private static recordMetric(operation: string, duration: number, details?: any) {
    this.metrics.push({
      operation,
      duration,
      timestamp: Date.now(),
      details
    });
    
    // Keep only recent metrics
    if (this.metrics.length > this.MAX_METRICS) {
      this.metrics = this.metrics.slice(-this.MAX_METRICS);
    }
  }
  
  /**
   * Get performance statistics for an operation
   */
  static getStats(operation?: string): any {
    const filtered = operation ? 
      this.metrics.filter(m => m.operation === operation) : 
      this.metrics;
      
    if (filtered.length === 0) return null;
    
    const durations = filtered.map(m => m.duration);
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    const recent = filtered.slice(-10); // Last 10 operations
    
    return {
      operation: operation || 'All operations',
      count: filtered.length,
      average: Math.round(avg),
      min,
      max,
      recent: recent.map(m => ({
        duration: m.duration,
        timestamp: new Date(m.timestamp).toLocaleTimeString()
      }))
    };
  }
  
  /**
   * Get all slow operations (>500ms)
   */
  static getSlowOperations(): PerformanceMetric[] {
    return this.metrics.filter(m => m.duration > 500);
  }
  
  /**
   * Clear metrics
   */
  static clear() {
    this.metrics = [];
  }
  
  /**
   * Export metrics as CSV for analysis
   */
  static exportCSV(): string {
    const headers = 'Operation,Duration(ms),Timestamp,Details\n';
    const rows = this.metrics.map(m => 
      `"${m.operation}",${m.duration},${new Date(m.timestamp).toISOString()},"${JSON.stringify(m.details || {})}"`
    ).join('\n');
    
    return headers + rows;
  }
}

// Export performance monitoring decorator
export function timed(operation: string) {
  return function(target: any, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    
    descriptor.value = async function(...args: any[]) {
      const stopTimer = PerformanceMonitor.startTimer(`${operation}:${propertyName}`);
      try {
        const result = await method.apply(this, args);
        stopTimer({ success: true, args: args.length });
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        stopTimer({ success: false, error: errorMessage });
        throw error;
      }
    };
  };
}

export { PerformanceMonitor };
