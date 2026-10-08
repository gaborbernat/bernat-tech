{{- /* markdown twin of project-list.html: a linked list instead of the stats table, which only makes sense rendered */ -}}
{{- range index hugo.Data.projects (.Get "group") }}
  {{- $repo := or .repo .name }}
- [{{ or .label .name }}](https://github.com/{{ .org }}/{{ $repo }}{{ if ne $repo .name }}/tree/HEAD/{{ .name }}{{ end }})
  {{- with .kind }}: {{ . }}{{ end }}{{ with .lang }} ({{ . }}){{ end }}
{{- end }}
