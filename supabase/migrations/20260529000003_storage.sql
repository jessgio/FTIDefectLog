-- FTI Defect Stock: private storage buckets and policies

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('defect-photos', 'defect-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('product-images', 'product-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy defect_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'defect-photos' and app.is_allowed_user());

create policy defect_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'defect-photos' and app.is_allowed_user());

create policy defect_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'defect-photos' and app.is_allowed_user())
  with check (bucket_id = 'defect-photos' and app.is_allowed_user());

create policy defect_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'defect-photos' and app.is_allowed_user());

create policy product_images_select on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and app.is_allowed_user());

create policy product_images_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and app.is_allowed_user());

create policy product_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and app.is_allowed_user())
  with check (bucket_id = 'product-images' and app.is_allowed_user());

create policy product_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and app.is_allowed_user());
