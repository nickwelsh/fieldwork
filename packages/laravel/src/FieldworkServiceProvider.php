<?php

declare(strict_types=1);

namespace Fieldwork\Laravel;

use Illuminate\Support\ServiceProvider;

final class FieldworkServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/fieldwork.php', 'fieldwork');
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([ExportCommand::class, HttpOperationsCommand::class]);
            $this->publishes([__DIR__.'/../config/fieldwork.php' => config_path('fieldwork.php')], 'fieldwork-config');
        }
    }
}
