<?php

declare(strict_types=1);

namespace Formbraid\Laravel;

use BackedEnum;
use InvalidArgumentException;
use ReflectionProperty;
use Stringable;

final class RequestExtractor
{
    private readonly Configuration $config;

    /** @param array<mixed>|Configuration $config */
    public function __construct(array|Configuration $config)
    {
        $this->config = is_array($config) ? Configuration::from($config) : $config;
    }

    /** @return array{form: array{id: class-string, defaultValues: \stdClass, fields: \stdClass, groups: \stdClass}, diagnostics: list<string>} */
    public function extract(object $request): array
    {
        if (! method_exists($request, 'rules')) {
            throw new InvalidArgumentException('A form source must define rules().');
        }
        $rules = $request->rules();
        if (! is_array($rules)) {
            throw new InvalidArgumentException('rules() must return an array.');
        }
        $overrides = method_exists($request, 'fields') ? $request->fields() : [];
        $groups = method_exists($request, 'groups') ? $request->groups() : [];
        if (! is_array($overrides) || ! is_array($groups)) {
            throw new InvalidArgumentException('fields() and groups() must return arrays.');
        }
        $fields = [];
        $diagnostics = [];
        foreach ($rules as $name => $fieldRules) {
            if (! is_string($name) || ! is_array($fieldRules) && ! is_string($fieldRules)) {
                throw new InvalidArgumentException('Validation rules must map field names to strings or arrays.');
            }
            $this->assertPath($name);
            $override = $overrides[$name] ?? Field::make();
            if (! $override instanceof Field) {
                throw new InvalidArgumentException("Field override {$name} must be a Field instance.");
            }
            $metadata = $override->toArray();
            $parsed = $this->parseRules($fieldRules);
            $type = $metadata['type'] ?? $this->inferFieldType($name, $parsed, array_keys($rules));
            if (! in_array($type, ['string', 'integer', 'number', 'boolean', 'date', 'enum', 'file', 'array', 'object'], true)) {
                throw new InvalidArgumentException("Unsupported value type {$type} for {$name}.");
            }
            $mapping = $this->mapping($type, $parsed);
            $component = $metadata['component'] ?? $mapping?->component;
            if (! is_string($component) || $component === '') {
                throw new InvalidArgumentException("No component mapping for {$name} ({$type}). Define a type mapping or fields() override.");
            }
            $constraints = $this->constraints($type, $parsed);
            $nullable = array_key_exists('nullable', $parsed);
            $portable = ['required', 'required_if', 'required_unless', 'required_with', 'required_without', 'nullable', 'string', 'integer', 'numeric', 'boolean', 'array', 'in'];
            if (in_array($type, ['string', 'integer', 'number', 'array', 'object'], true)) {
                $portable = array_merge($portable, ['min', 'max', 'between']);
            }
            $serverRules = array_values(array_diff(array_keys($parsed), $portable));
            $fields[$name] = [
                'name' => $name,
                'type' => $type,
                'component' => $component,
                'label' => $metadata['label'] ?? $this->titleCase($name),
                'props' => (object) array_replace($mapping === null ? [] : $mapping->props, $metadata['props'] ?? []),
                'constraints' => (object) $constraints,
                'nullable' => $nullable,
                'serverRules' => $serverRules,
            ];
            if (isset($metadata['helpText'])) {
                $fields[$name]['helpText'] = $metadata['helpText'];
            }
            foreach ($serverRules as $rule) {
                $diagnostics[] = $request::class.".{$name}: {$rule} remains server validation.";
            }
        }
        foreach (array_keys($overrides) as $name) {
            if (! isset($fields[$name])) {
                throw new InvalidArgumentException("Field override {$name} has no validation rules.");
            }
        }
        $serializedGroups = [];
        $claimed = [];
        foreach ($groups as $name => $group) {
            if (! is_string($name) || ! $group instanceof FieldGroup) {
                throw new InvalidArgumentException("Group {$name} must be a FieldGroup instance.");
            }
            $metadata = $group->toArray();
            foreach ($metadata['fields'] as $path) {
                if (! isset($fields[$path]) || isset($claimed[$path])) {
                    throw new InvalidArgumentException("Group {$name} references unknown or already grouped field {$path}.");
                }
                $claimed[$path] = true;
            }
            $metadata['fields'] = (object) $metadata['fields'];
            $metadata['props'] = (object) $metadata['props'];
            $serializedGroups[$name] = $metadata;
        }
        $form = [
            'id' => $request::class,
            'defaultValues' => (object) $this->defaultValues($fields),
            'fields' => (object) $fields,
            'groups' => (object) $serializedGroups,
        ];
        // Fail immediately for callbacks/resources/non-serializable component props.
        $this->assertSerializable($form);

        return ['form' => $form, 'diagnostics' => $diagnostics];
    }

    /**
     * @param  string|array<mixed>  $rules
     * @return array<string, list<string|int>>
     */
    private function parseRules(string|array $rules): array
    {
        if (is_string($rules)) {
            $rules = explode('|', $rules);
        }
        $parsed = [];
        foreach ($rules as $rule) {
            if (is_object($rule) && is_a($rule, 'Illuminate\\Validation\\Rules\\Enum')) {
                $class = (new ReflectionProperty($rule, 'type'))->getValue($rule);
                if (! is_string($class) || ! is_subclass_of($class, BackedEnum::class)) {
                    throw new InvalidArgumentException('Enum fields require a backed enum.');
                }
                $parsed['in'] = array_map(static fn (BackedEnum $case): string|int => $case->value, $class::cases());
                $parsed['enum'] = [];

                continue;
            }
            if ($rule instanceof Stringable) {
                $rule = (string) $rule;
            }
            if (! is_string($rule)) {
                $parsed[is_object($rule) ? $rule::class : 'custom'] = [];

                continue;
            }
            [$name, $parameters] = array_pad(explode(':', $rule, 2), 2, '');
            $parsed[strtolower($name)] = $parameters === '' ? [] : array_map(static fn (?string $parameter): string => $parameter ?? '', str_getcsv($parameters, escape: ''));

        }

        return $parsed;
    }

    /** @param array<string, list<string|int>> $rules */
    private function inferType(array $rules): string
    {
        $types = [];
        foreach (['string' => 'string', 'email' => 'string', 'url' => 'string', 'integer' => 'integer', 'numeric' => 'number', 'boolean' => 'boolean', 'date' => 'date', 'date_format' => 'date', 'file' => 'file', 'image' => 'file', 'array' => 'array'] as $rule => $type) {
            if (array_key_exists($rule, $rules)) {
                $types[$type] = true;
            }
        }
        if (isset($types['integer'])) {
            unset($types['number']);
        }
        if (count($types) > 1) {
            throw new InvalidArgumentException('Conflicting value types: '.implode(', ', array_keys($types)));
        }
        if (array_key_exists('in', $rules) && isset($types['array'])) {
            return 'array';
        }
        if (array_key_exists('enum', $rules) || array_key_exists('in', $rules)) {
            return 'enum';
        }

        return array_key_first($types) ?? $this->config->fallbackType ?? throw new InvalidArgumentException('Unable to infer a field value type.');
    }

    /**
     * @param  array<string, list<string|int>>  $rules
     * @param  list<int|string>  $paths
     */
    private function inferFieldType(string $name, array $rules, array $paths): string
    {
        $type = $this->inferType($rules);
        if ($type !== 'array') {
            return $type;
        }
        $parent = explode('.', $name);
        foreach ($paths as $path) {
            if (! is_string($path)) {
                continue;
            }
            $parts = explode('.', $path);
            if (count($parts) <= count($parent) || ! $this->matchesParent($parent, $parts)) {
                continue;
            }
            $child = $parts[count($parent)];
            // Laravel arrays include associative records; canonical numeric indexes and wildcards describe lists.
            if ($child !== '*' && ! preg_match('/^(?:0|[1-9][0-9]*)$/D', $child)) {
                return 'object';
            }
        }

        return 'array';
    }

    /**
     * @param  list<string>  $parent
     * @param  list<string>  $parts
     */
    private function matchesParent(array $parent, array $parts): bool
    {
        foreach ($parent as $index => $segment) {
            if ($segment !== '*' && $parts[$index] !== '*' && $parts[$index] !== $segment) {
                return false;
            }
        }

        return true;
    }

    /** @param array<string, list<string|int>> $rules */
    private function mapping(string $type, array $rules): ?ComponentMapping
    {
        $mapping = $this->config->types[$type] ?? null;
        if ($mapping === null && $type === 'object' && array_key_exists('array', $rules)) {
            $mapping = $this->config->types['array'] ?? null;
        }
        foreach ($this->config->rules as $rule => $specific) {
            if (array_key_exists($rule, $rules)) {
                return new ComponentMapping($specific->component, array_replace($mapping === null ? [] : $mapping->props, $specific->props));
            }
        }

        return $mapping;
    }

    /**
     * @param  array<string, list<string|int>>  $rules
     * @return array<string, mixed>
     */
    private function constraints(string $type, array $rules): array
    {
        $constraints = ['required' => array_key_exists('required', $rules)];
        foreach (['min', 'max'] as $bound) {
            $value = $rules[$bound][0] ?? null;
            if (isset($rules['between'])) {
                $value = $rules['between'][$bound === 'min' ? 0 : 1] ?? $value;
            }
            if ($value !== null && is_numeric($value)) {
                $key = match ($type) {
                    'string' => $bound.'Length',
                    'array', 'object' => $bound.'Items',
                    'integer', 'number' => $bound,
                    default => null,
                };
                if ($key !== null) {
                    $constraints[$key] = (float) $value;
                }
            }
        }
        if (array_key_exists('in', $rules)) {
            $constraints['options'] = array_map(static function (string|int $option) use ($rules): string|int|float {
                if (isset($rules['integer']) || isset($rules['numeric'])) {
                    if (! is_numeric($option)) {
                        throw new InvalidArgumentException('Numeric enum options must be numeric.');
                    }

                    return isset($rules['integer']) ? (int) $option : (float) $option;
                }

                return $option;
            }, $rules['in']);
        }
        foreach (['email', 'url', 'date'] as $format) {
            if (array_key_exists($format, $rules)) {
                $constraints['format'] = $format;
                break;
            }
        }
        $conditions = [];
        foreach (['required_if' => 'equals', 'required_unless' => 'notEquals', 'required_with' => 'present', 'required_without' => 'absent'] as $rule => $operator) {
            if (! isset($rules[$rule])) {
                continue;
            }
            $parameters = $rules[$rule];
            if ($operator === 'present' || $operator === 'absent') {
                foreach ($parameters as $field) {
                    if (is_string($field)) {
                        $conditions[] = ['field' => $field, 'operator' => $operator, 'values' => []];
                    }
                }
            } else {
                $field = array_shift($parameters);
                if (is_string($field)) {
                    $conditions[] = ['field' => $field, 'operator' => $operator, 'values' => $parameters];
                }
            }
        }
        if ($conditions !== []) {
            $constraints['requiredWhen'] = $conditions;
        }

        return $constraints;
    }

    private function titleCase(string $path): string
    {
        $parts = array_values(array_filter(explode('.', $path), static fn (string $part): bool => $part !== '*' && ! ctype_digit($part)));
        $name = array_pop($parts) ?? $path;

        return ucwords(str_replace(['_', '-'], ' ', preg_replace('/([a-z\d])([A-Z])/', '$1 $2', $name) ?? $name));
    }

    private function assertPath(string $path): void
    {
        foreach (explode('.', $path) as $part) {
            if ($part === '' || in_array($part, ['__proto__', 'constructor', 'prototype'], true)) {
                throw new InvalidArgumentException("Invalid field path: {$path}");
            }
        }
    }

    /**
     * @param  array<string, array{name: string, type: string, nullable: bool}>  $fields
     * @return array<string, mixed>
     */
    private function defaultValues(array $fields): array
    {
        // Initialize containers before their descendants, independently of rule declaration order.
        uasort($fields, static fn (array $a, array $b): int => substr_count($a['name'], '.') <=> substr_count($b['name'], '.'));
        $values = [];
        foreach ($fields as $field) {
            if (str_contains($field['name'], '*')) {
                continue;
            }
            $default = $field['nullable'] || $field['type'] === 'file' ? null : match ($field['type']) {
                'boolean' => false,
                'array' => [],
                'object' => (object) [],
                'integer', 'number' => 0,
                default => '',
            };
            $this->setNested($values, $field['name'], $default);
        }

        return $values;
    }

    /** @param array<string, mixed> $values */
    private function setNested(array &$values, string $path, mixed $value): void
    {
        $parts = explode('.', $path);
        $current = &$values;
        foreach ($parts as $index => $part) {
            if (is_array($current)) {
                if ($index === count($parts) - 1) {
                    $current[$part] = $value;

                    return;
                }
                if (array_key_exists($part, $current) && $current[$part] === null) {
                    return;
                }
                $current[$part] ??= [];
                if (! is_array($current[$part]) && ! $current[$part] instanceof \stdClass) {
                    throw new InvalidArgumentException("Conflicting nested field: {$path}");
                }
                $current = &$current[$part];
            } else {
                if ($index === count($parts) - 1) {
                    $current->{$part} = $value;

                    return;
                }
                if (property_exists($current, $part) && $current->{$part} === null) {
                    return;
                }
                $current->{$part} ??= [];
                if (! is_array($current->{$part}) && ! $current->{$part} instanceof \stdClass) {
                    throw new InvalidArgumentException("Conflicting nested field: {$path}");
                }
                $current = &$current->{$part};
            }
        }
    }

    private function assertSerializable(mixed $value): void
    {
        if ($value instanceof \Closure || is_resource($value) || is_object($value) && ! $value instanceof \stdClass) {
            throw new InvalidArgumentException('Formbraid metadata must contain only JSON values.');
        }
        if (is_array($value) || $value instanceof \stdClass) {
            foreach ((array) $value as $nested) {
                $this->assertSerializable($nested);
            }
        }
        json_encode($value, JSON_THROW_ON_ERROR);
    }
}
