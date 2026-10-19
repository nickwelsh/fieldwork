<?php

declare(strict_types=1);

namespace Formbraid\Laravel;

use InvalidArgumentException;

final readonly class Configuration
{
    /**
     * @param  array<string, ComponentMapping>  $types
     * @param  array<string, ComponentMapping>  $rules
     * @param  list<string>  $requests
     */
    public function __construct(public array $types, public array $rules, public ?string $fallbackType, public array $requests) {}

    /** @param array<mixed> $config */
    public static function from(array $config): self
    {
        $fields = $config['fields'] ?? [];
        $directories = $config['requests'] ?? [];
        if (! is_array($fields) || ! is_array($directories)) {
            throw new InvalidArgumentException('Invalid Formbraid fields or requests configuration.');
        }
        $types = $fields['types'] ?? [];
        $rules = $fields['rules'] ?? [];
        $fallback = $fields['fallbackType'] ?? null;
        if (! is_array($types) || ! is_array($rules) || $fallback !== null && ! is_string($fallback)) {
            throw new InvalidArgumentException('Invalid Formbraid type mappings.');
        }
        $requests = [];
        foreach ($directories as $directory) {
            if (! is_string($directory)) {
                throw new InvalidArgumentException('Request directories must be strings.');
            }
            $requests[] = $directory;
        }

        return new self(self::mappings($types), self::mappings($rules), $fallback, $requests);
    }

    /**
     * @param  array<mixed>  $values
     * @return array<string, ComponentMapping>
     */
    private static function mappings(array $values): array
    {
        $result = [];
        foreach ($values as $name => $mapping) {
            if (! is_string($name)) {
                throw new InvalidArgumentException('Mapping keys must be strings.');
            }
            $result[$name] = ComponentMapping::from($mapping);
        }

        return $result;
    }
}
