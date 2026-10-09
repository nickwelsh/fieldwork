<?php

declare(strict_types=1);

namespace Fieldwork\Laravel;

use Illuminate\Console\Command;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Routing\Router;
use ReflectionFunction;
use ReflectionMethod;
use ReflectionNamedType;

final class HttpOperationsCommand extends Command
{
    protected $signature = 'fieldwork:http';

    protected $description = 'Export HTTP operations associated with Laravel FormRequests';

    public function handle(Router $router): int
    {
        $operations = [];
        foreach ($router->getRoutes()->getRoutes() as $route) {
            $action = $route->getAction('uses');
            if ($action instanceof \Closure) {
                $reflection = new ReflectionFunction($action);
            } elseif (is_string($action) && str_contains($action, '@')) {
                [$controller, $method] = explode('@', $action, 2);
                $reflection = new ReflectionMethod($controller, $method);
            } else {
                continue;
            }
            $requests = [];
            foreach ($reflection->getParameters() as $parameter) {
                $type = $parameter->getType();
                if ($type instanceof ReflectionNamedType && is_subclass_of($type->getName(), FormRequest::class)) {
                    $requests[] = $type->getName();
                }
            }
            if (count($requests) > 1) {
                throw new \RuntimeException('A route operation must reference exactly one FormRequest.');
            }
            if ($requests === []) {
                continue;
            }
            $methods = [];
            foreach ($route->methods() as $method) {
                if (! is_string($method)) {
                    throw new \RuntimeException('Invalid Laravel route method.');
                }
                if (in_array(strtolower($method), ['get', 'post', 'put', 'patch', 'delete'], true)) {
                    $methods[] = $method;
                }
            }
            $parameters = [];
            foreach ($route->parameterNames() as $name) {
                if (! is_string($name)) {
                    throw new \RuntimeException('Invalid Laravel route parameter.');
                }
                $parameters[] = ['name' => $name, 'optional' => str_contains($route->uri(), '{'.$name.'?}')];
            }
            foreach ($methods as $method) {
                $name = $route->getName();
                if (! is_string($name)) {
                    $name = str_replace(['\\', '@'], '.', is_string($action) ? $action : $requests[0].'.'.$method);
                }
                if (count($methods) > 1) {
                    $name .= '.'.strtolower($method);
                }
                $operations[] = [
                    'name' => $name,
                    'schema' => $requests[0],
                    'parameters' => $parameters,
                    'binding' => ['uri' => $route->uri(), 'method' => strtolower($method)],
                ];
            }
        }
        usort($operations, static fn (array $left, array $right): int => strcmp($left['name'], $right['name']));
        $this->line(json_encode(['version' => 1, 'operations' => $operations], JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        return self::SUCCESS;
    }
}
